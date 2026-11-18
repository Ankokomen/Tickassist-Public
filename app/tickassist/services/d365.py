"""Dynamics 365 (Dataverse Web API) integration for TickAssist.

TickAssist signs in as the user - a public client using the OAuth 2.0
authorization-code flow with PKCE, so there is no client secret to keep - and
calls the Dataverse Web API with the user's own D365 permissions. Standard
library only, like the rest of the app.

What it needs from IT (once): an app registration in Microsoft Entra ID with
  * platform "Mobile and desktop applications", redirect URI
    http://localhost/d365/callback (Entra ignores the port for localhost),
  * "Allow public client flows" = Yes,
  * API permission Dynamics CRM > user_impersonation (delegated), consented.
The tenant ID and the app's client ID go into Settings > Integrations >
Dynamics 365.

Tokens: the refresh token is kept in this PC's settings (never
returned by /api/settings); access tokens live in memory and are renewed from
it. Sign out deletes it.
"""

import base64
import hashlib
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

# Overridable so the tests can stand in a fake Entra ID.
AUTHORITY = os.environ.get("TA_D365_AUTHORITY", "https://login.microsoftonline.com")
API_VERSION = "v9.2"
CALLBACK_PATH = "/d365/callback"
TIMEOUT = 30
STATE_TTL = 600            # seconds a sign-in may take
MAX_MATCHES = 10


class D365Error(Exception):
    """A failure worth showing the user as-is."""

    def __init__(self, message, status=400, signed_out=False):
        super().__init__(message)
        self.status = status
        self.signed_out = signed_out


def _digits(text):
    return "".join(ch for ch in (text or "") if ch.isdigit())


def _odata_str(value):
    """A string literal for $filter: single quotes doubled."""
    return "'" + str(value).replace("'", "''") + "'"


def _guid(value):
    value = (value or "").strip().strip("{}")
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", value):
        raise D365Error("That is not a valid record id.")
    return value


def text_to_html(text):
    """D365 notes are rich text; <br> keeps the note's line breaks."""
    esc = (text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return "<div>" + esc.replace("\r\n", "\n").replace("\n", "<br>") + "</div>"


class D365Client:
    def __init__(self, settings):
        self.settings = settings
        self._lock = threading.Lock()
        self._token = None          # (access_token, expires_at, org)
        self._pending = {}          # state -> {verifier, redirect, at}
        self._who = None            # cached signed-in user's name

    # ---- configuration ---------------------------------------------------
    def config(self):
        s = self.settings.all()
        org = (s.get("d365_org_url") or "").strip().rstrip("/")
        return {
            "org": org,
            "tenant": (s.get("d365_tenant_id") or "").strip(),
            "client": (s.get("d365_client_id") or "").strip(),
            "refresh": (s.get("d365_refresh_token") or "").strip(),
            "user": s.get("d365_user") or "",
            "case_type": (s.get("d365_case_type") or "").strip(),
            "origin": (s.get("d365_case_origin") or "").strip(),
            "extra": (s.get("d365_case_extra") or "").strip(),
            "customer_mode": (s.get("d365_customer_mode") or "account").strip(),
            "note_html": str(s.get("d365_note_html", "1")) == "1",
        }

    def status(self):
        c = self.config()
        return {
            "configured": bool(c["org"] and c["tenant"] and c["client"]),
            "signed_in": bool(c["refresh"]),
            "user": c["user"],
            "org": c["org"],
            "customer_mode": c["customer_mode"],
        }

    def _scope(self, org):
        return f"{org}/user_impersonation offline_access openid profile"

    # ---- sign-in ---------------------------------------------------------
    def begin_login(self, redirect_uri):
        c = self.config()
        if not (c["org"] and c["tenant"] and c["client"]):
            raise D365Error("Fill in the D365 URL, Tenant ID and Client ID in Settings first.")
        verifier = secrets.token_urlsafe(64)
        challenge = base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode("ascii")).digest()).decode("ascii").rstrip("=")
        state = secrets.token_urlsafe(24)
        now = time.time()
        with self._lock:
            self._pending = {k: v for k, v in self._pending.items() if now - v["at"] < STATE_TTL}
            self._pending[state] = {"verifier": verifier, "redirect": redirect_uri, "at": now}
        q = urllib.parse.urlencode({
            "client_id": c["client"],
            "response_type": "code",
            "redirect_uri": redirect_uri,
            "response_mode": "query",
            "scope": self._scope(c["org"]),
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "prompt": "select_account",
        })
        return f"{AUTHORITY}/{urllib.parse.quote(c['tenant'])}/oauth2/v2.0/authorize?{q}"

    def finish_login(self, query):
        if query.get("error"):
            raise D365Error("Microsoft sign-in said: %s" % (
                query.get("error_description") or query.get("error")))
        state = query.get("state") or ""
        with self._lock:
            pending = self._pending.pop(state, None)
        if not pending or time.time() - pending["at"] > STATE_TTL:
            raise D365Error("This sign-in link expired. Start again from TickAssist.")
        code = query.get("code") or ""
        if not code:
            raise D365Error("Microsoft did not return a sign-in code.")
        c = self.config()
        tok = self._token_request({
            "grant_type": "authorization_code",
            "client_id": c["client"],
            "code": code,
            "redirect_uri": pending["redirect"],
            "code_verifier": pending["verifier"],
            "scope": self._scope(c["org"]),
        }, c)
        name = self._name_from_id_token(tok.get("id_token"))
        self.settings.update({"d365_user": name})
        self._who = name
        return name

    def sign_out(self):
        with self._lock:
            self._token = None
        self._who = None
        self.settings.update({"d365_refresh_token": "", "d365_user": ""})

    @staticmethod
    def _name_from_id_token(id_token):
        try:
            payload = id_token.split(".")[1]
            payload += "=" * (-len(payload) % 4)
            claims = json.loads(base64.urlsafe_b64decode(payload))
            return claims.get("name") or claims.get("preferred_username") or ""
        except Exception:  # noqa: BLE001 - a display nicety only
            return ""

    def _token_request(self, form, c):
        url = f"{AUTHORITY}/{urllib.parse.quote(c['tenant'])}/oauth2/v2.0/token"
        req = urllib.request.Request(
            url, data=urllib.parse.urlencode(form).encode("ascii"), method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded"})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
                tok = json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            try:
                body = json.loads(err.read().decode("utf-8"))
            except Exception:  # noqa: BLE001
                body = {}
            desc = (body.get("error_description") or "").split("\r\n")[0]
            code = body.get("error") or ""
            if code == "invalid_grant":
                self.settings.update({"d365_refresh_token": ""})
                raise D365Error("Your D365 sign-in has expired. Sign in again in Settings.",
                                401, signed_out=True)
            if "AADSTS7000218" in desc:
                desc += " - ask IT to set 'Allow public client flows' to Yes on the app registration."
            raise D365Error("Microsoft sign-in failed: %s" % (desc or code or err), 401)
        except (urllib.error.URLError, OSError) as err:
            raise D365Error("Could not reach Microsoft sign-in: %s" % getattr(err, "reason", err), 502)
        access = tok.get("access_token")
        if not access:
            raise D365Error("Microsoft sign-in returned no access token.", 401)
        if tok.get("refresh_token"):
            self.settings.update({"d365_refresh_token": tok["refresh_token"]})
        with self._lock:
            self._token = (access, time.time() + int(tok.get("expires_in") or 3600) - 120, c["org"])
        return tok

    def _access_token(self):
        c = self.config()
        with self._lock:
            tok = self._token
        if tok and tok[1] > time.time() and tok[2] == c["org"]:
            return tok[0], c
        if not c["refresh"]:
            raise D365Error("Not signed in to D365. Sign in under Settings > Integrations > Dynamics 365.",
                            401, signed_out=True)
        self._token_request({
            "grant_type": "refresh_token",
            "client_id": c["client"],
            "refresh_token": c["refresh"],
            "scope": self._scope(c["org"]),
        }, c)
        with self._lock:
            return self._token[0], c

    # ---- Web API ---------------------------------------------------------
    def api(self, method, path, body=None, prefer=None, _retry=True):
        token, c = self._access_token()
        url = f"{c['org']}/api/data/{API_VERSION}/{path}"
        headers = {
            "Authorization": "Bearer " + token,
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
            "Prefer": 'odata.include-annotations="*"'
                      + (("," + prefer) if prefer else ""),
        }
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
                raw = res.read()
                entity = res.headers.get("OData-EntityId") or ""
                out = json.loads(raw.decode("utf-8")) if raw else {}
                if entity and isinstance(out, dict):
                    out.setdefault("@entity", entity)
                return out
        except urllib.error.HTTPError as err:
            if err.code == 401 and _retry:
                with self._lock:
                    self._token = None
                return self.api(method, path, body, prefer, _retry=False)
            try:
                msg = json.loads(err.read().decode("utf-8")).get("error", {}).get("message", "")
            except Exception:  # noqa: BLE001
                msg = ""
            if err.code == 403:
                msg = "D365 refused this (your security role may not allow it). " + msg
            raise D365Error("D365: %s" % (msg or "HTTP %d" % err.code), 502 if err.code >= 500 else 400)
        except (urllib.error.URLError, OSError) as err:
            raise D365Error("Could not reach D365: %s" % getattr(err, "reason", err), 502)

    def whoami(self):
        who = self.api("GET", "WhoAmI")
        uid = who.get("UserId")
        user = self.api("GET", f"systemusers({_guid(uid)})?$select=fullname,domainname") if uid else {}
        return {"user_id": uid, "name": user.get("fullname") or self._who or "",
                "login": user.get("domainname") or ""}

    # ---- lookups ---------------------------------------------------------
    CONTACT_PHONES = ("telephone1", "mobilephone", "telephone2")
    ACCOUNT_PHONES = ("telephone1", "telephone2")

    @staticmethod
    def _phone_filter(fields, digits):
        """D365 keeps phones as typed, so search the common spellings of the
        last 7 digits and confirm the full number afterwards."""
        last7 = digits[-7:]
        forms = {last7, f"{last7[:3]}-{last7[3:]}", f"{last7[:3]} {last7[3:]}",
                 f"{last7[:3]}.{last7[3:]}"}
        parts = [f"contains({f},{_odata_str(v)})" for f in fields for v in sorted(forms)]
        return "(" + " or ".join(parts) + ")"

    @staticmethod
    def _phone_matches(record, fields, digits):
        want = digits[-10:]            # may be shorter: a number typed without its area code
        return any(_digits(record.get(f))[-len(want):] == want for f in fields if record.get(f))

    def _contact_row(self, r):
        acct_name = r.get("_parentcustomerid_value@OData.Community.Display.V1.FormattedValue") or ""
        kind = (r.get("_parentcustomerid_value@Microsoft.Dynamics.CRM.lookuplogicalname") or "")
        return {
            "kind": "contact",
            "id": r.get("contactid"),
            "name": r.get("fullname") or "",
            "phone": r.get("telephone1") or r.get("mobilephone") or r.get("telephone2") or "",
            "email": r.get("emailaddress1") or "",
            "account_id": r.get("_parentcustomerid_value") if kind in ("", "account") else None,
            "account_name": acct_name,
        }

    @staticmethod
    def _account_row(r):
        return {
            "kind": "account",
            "id": r.get("accountid"),
            "name": r.get("name") or "",
            "phone": r.get("telephone1") or r.get("telephone2") or "",
            "email": r.get("emailaddress1") or "",
            "account_number": r.get("accountnumber") or "",
            "city": r.get("address1_city") or "",
        }

    def find_customers(self, phone="", name=""):
        """Contacts and accounts by phone (exact on digits) or by name."""
        out = []
        digits = _digits(phone)
        cfields = ",".join(("contactid", "fullname", "emailaddress1", "_parentcustomerid_value")
                           + self.CONTACT_PHONES)
        afields = ",".join(("accountid", "name", "accountnumber", "emailaddress1", "address1_city")
                           + self.ACCOUNT_PHONES)
        active = "statecode eq 0"
        if len(digits) >= 7:
            q = _query("contacts", select=cfields, top=50, filter=f"{active} and "
                       + self._phone_filter(self.CONTACT_PHONES, digits))
            for r in self.api("GET", q).get("value", []):
                if self._phone_matches(r, self.CONTACT_PHONES, digits):
                    out.append(self._contact_row(r))
            q = _query("accounts", select=afields, top=50, filter=f"{active} and "
                       + self._phone_filter(self.ACCOUNT_PHONES, digits))
            for r in self.api("GET", q).get("value", []):
                if self._phone_matches(r, self.ACCOUNT_PHONES, digits):
                    out.append(self._account_row(r))
        name = (name or "").strip()
        if name:
            lit = _odata_str(name)
            q = _query("contacts", select=cfields, top=MAX_MATCHES, orderby="fullname",
                       filter=f"{active} and contains(fullname,{lit})")
            out += [self._contact_row(r) for r in self.api("GET", q).get("value", [])]
            q = _query("accounts", select=afields, top=MAX_MATCHES, orderby="name",
                       filter=f"{active} and (contains(name,{lit}) or accountnumber eq {lit})")
            out += [self._account_row(r) for r in self.api("GET", q).get("value", [])]
        seen, unique = set(), []
        for row in out:
            if row["id"] and row["id"] not in seen:
                seen.add(row["id"])
                unique.append(row)
        return unique[:2 * MAX_MATCHES]

    def find_case(self, case_number):
        num = (case_number or "").strip()
        if not num or num.upper() == "CAS":
            raise D365Error("Enter the Case ID first.")
        q = _query("incidents", select="incidentid,ticketnumber,title,statecode,_customerid_value",
                   top=2, filter=f"ticketnumber eq {_odata_str(num)}")
        rows = self.api("GET", q).get("value", [])
        if not rows:
            raise D365Error(f"No D365 case numbered {num}.", 404)
        r = rows[0]
        return {
            "id": r["incidentid"],
            "number": r.get("ticketnumber") or num,
            "title": r.get("title") or "",
            "customer": r.get("_customerid_value@OData.Community.Display.V1.FormattedValue") or "",
            "status": r.get("statecode@OData.Community.Display.V1.FormattedValue") or "",
            "active": r.get("statecode") == 0,
            "url": self.case_url(r["incidentid"]),
        }

    def case_url(self, incident_id):
        org = self.config()["org"]
        return f"{org}/main.aspx?pagetype=entityrecord&etn=incident&id={incident_id}"

    # ---- creating ----------------------------------------------------------
    def create_case(self, title, description, customer, contact_id=None):
        """customer: {"kind": "contact"|"account", "id": ...}."""
        title = (title or "").strip()
        if not title:
            raise D365Error("A case needs a Case Title.")
        if not customer or customer.get("kind") not in ("contact", "account"):
            raise D365Error("Pick the customer for this case.")
        c = self.config()
        body = {"title": title[:200], "description": description or ""}
        body[f"customerid_{customer['kind']}@odata.bind"] = (
            f"/{customer['kind']}s({_guid(customer['id'])})")
        if contact_id:
            body["primarycontactid@odata.bind"] = f"/contacts({_guid(contact_id)})"
        for key, setting in (("casetypecode", c["case_type"]), ("caseorigincode", c["origin"])):
            if setting:
                if not setting.lstrip("-").isdigit():
                    raise D365Error(f"The {key} setting must be a number from D365.")
                body[key] = int(setting)
        if c["extra"]:
            try:
                extra = json.loads(c["extra"])
            except ValueError:
                raise D365Error("Extra case fields in Settings is not valid JSON.")
            if not isinstance(extra, dict):
                raise D365Error("Extra case fields in Settings must be a JSON object.")
            body.update(extra)
        res = self.api("POST", "incidents?$select=incidentid,ticketnumber,title", body,
                       prefer="return=representation")
        iid = res.get("incidentid")
        if not iid:
            m = re.search(r"\(([0-9a-fA-F-]{36})\)", res.get("@entity", ""))
            iid = m.group(1) if m else None
        number = res.get("ticketnumber") or ""
        if iid and not number:
            number = self.api("GET", f"incidents({iid})?$select=ticketnumber").get("ticketnumber", "")
        return {"id": iid, "number": number, "title": res.get("title") or title,
                "url": self.case_url(iid) if iid else ""}

    def add_note(self, incident_id, subject, text, photos=()):
        """One timeline note with the text, then one note per photo (a D365
        note holds a single attachment)."""
        iid = _guid(incident_id)
        c = self.config()
        bind = {"objectid_incident@odata.bind": f"/incidents({iid})"}
        created = []
        if (text or "").strip():
            body = dict(bind, subject=(subject or "TickAssist note")[:500],
                        notetext=text_to_html(text) if c["note_html"] else text)
            res = self.api("POST", "annotations?$select=annotationid", body,
                           prefer="return=representation")
            created.append(res.get("annotationid"))
        total = len(photos)
        for i, p in enumerate(photos, 1):
            body = dict(bind,
                        subject=f"{subject or 'Photo'} - photo {i} of {total}"[:500],
                        filename=p["filename"],
                        mimetype=p["mime"],
                        documentbody=base64.b64encode(p["data"]).decode("ascii"))
            res = self.api("POST", "annotations?$select=annotationid", body,
                           prefer="return=representation")
            created.append(res.get("annotationid"))
        return {"notes": len(created), "photos": total}

    # ---- the org's case form ---------------------------------------------
    def case_form_info(self):
        """Required case fields, plus Case Type / Origin choices, so Settings
        can offer them instead of asking for raw numbers."""
        attrs = self.api("GET", _query(
            "EntityDefinitions(LogicalName='incident')/Attributes",
            select="LogicalName,DisplayName,RequiredLevel,AttributeType,IsValidForCreate"))
        handled = {"title", "customerid", "description", "casetypecode", "caseorigincode",
                   "primarycontactid", "ownerid", "statecode", "statuscode", "ticketnumber"}
        required = []
        for a in attrs.get("value", []):
            level = (a.get("RequiredLevel") or {}).get("Value")
            if level in ("ApplicationRequired", "SystemRequired") and a.get("IsValidForCreate") \
                    and a.get("LogicalName") not in handled and a.get("AttributeType") != "Virtual":
                label = ((a.get("DisplayName") or {}).get("UserLocalizedLabel") or {}).get("Label")
                required.append({"name": a["LogicalName"], "label": label or a["LogicalName"],
                                 "type": a.get("AttributeType")})
        choices = {}
        for field in ("casetypecode", "caseorigincode"):
            try:
                meta = self.api("GET", _query(
                    f"EntityDefinitions(LogicalName='incident')/Attributes(LogicalName='{field}')"
                    "/Microsoft.Dynamics.CRM.PicklistAttributeMetadata",
                    select="LogicalName", expand="OptionSet($select=Options)"))
                opts = (meta.get("OptionSet") or {}).get("Options") or []
                choices[field] = [{
                    "value": o.get("Value"),
                    "label": ((o.get("Label") or {}).get("UserLocalizedLabel") or {}).get("Label")
                    or str(o.get("Value")),
                } for o in opts]
            except D365Error:
                choices[field] = []
        return {"required": sorted(required, key=lambda r: r["label"]), "choices": choices}


def _query(path, **options):
    """path?$select=...&$filter=... with each value percent-encoded, so a name
    like "Smith & Sons" cannot break the query string."""
    parts = []
    for key in ("select", "filter", "orderby", "top", "expand"):
        if key in options and options[key] not in (None, ""):
            parts.append("$%s=%s" % (key, urllib.parse.quote(str(options[key]), safe="(),'$=:")))
    return path + ("?" + "&".join(parts) if parts else "")


# ---- what the Note Generator asks for ---------------------------------------------
_PHOTO_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
              "image/webp": "webp", "image/bmp": "bmp"}


def _attachments(tickets, photo_ids, case_number):
    """Stored photos as note attachments named CAS0485494-1.jpg, -2, ..."""
    out = []
    base = re.sub(r"[^\w-]+", "", case_number or "") or "photo"
    for i, pid in enumerate(photo_ids):
        photo = tickets.photo(int(pid))
        if not photo:
            raise D365Error("A photo was removed before it could be sent.")
        out.append({"id": photo["id"], "mime": photo["mime"], "data": bytes(photo["data"]),
                    "filename": "%s-%d.%s" % (base, i + 1, _PHOTO_EXT.get(photo["mime"], "img"))})
    return out


def create_case_with_note(client, tickets, data):
    """Create the case, then its note and photos. The case is returned even if
    the note fails, so the form always learns about the case that now exists."""
    # Read before the case is made: what is wrong with the request must not
    # come to light when the case already exists.
    note = data.get("note") if isinstance(data.get("note"), dict) else {}
    ids = [int(i) for i in (data.get("photo_ids") or [])]
    case = client.create_case(data.get("title"), data.get("description"),
                              data.get("customer"), data.get("contact_id"))
    result = {"case": case}
    if ((note.get("text") or "").strip() or ids) and case.get("id"):
        try:
            photos = _attachments(tickets, ids, case.get("number"))
            result["note"] = client.add_note(case["id"], note.get("subject"), note.get("text"), photos)
            tickets.mark_sent(ids)
        except Exception as err:      # noqa: BLE001 - whatever it was, the case is there
            result["note_error"] = str(err)
    return result


def add_note_to_case(client, tickets, data):
    """Send to D365: the note (and photos not sent yet) onto the case in Case ID."""
    ids = [int(i) for i in (data.get("photo_ids") or [])]
    case = client.find_case(data.get("number"))
    if data.get("incident_id") and data["incident_id"] != case["id"]:
        raise D365Error("The case changed - check the Case ID and try again.")
    photos = _attachments(tickets, ids, case["number"])
    note = client.add_note(case["id"], data.get("subject"), data.get("text"), photos)
    tickets.mark_sent(ids)
    return {"case": case, "note": note}
