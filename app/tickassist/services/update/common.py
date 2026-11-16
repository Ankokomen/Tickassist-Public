"""What every part of updating shares: the error type, version numbers and
fetching from a web address."""

import re
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT = 20
_HEADERS = {"User-Agent": "TickAssist-updater", "Accept": "application/json, application/zip, */*"}
# The only host an access token is ever sent to.
TOKEN_HOST = "api.github.com"


class UpdateError(Exception):
    """A problem the user can act on. `status` is the HTTP status the update
    server answered with, when that was the problem."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def parse_version(text):
    return tuple(int(n) for n in re.findall(r"\d+", str(text or ""))[:4]) or (0,)


def is_newer(latest, current):
    a, b = parse_version(latest), parse_version(current)
    width = max(len(a), len(b))
    return a + (0,) * (width - len(a)) > b + (0,) * (width - len(b))


def allowed(url):
    parts = urllib.parse.urlparse(url)
    if parts.scheme == "https":
        return True
    # Plain http only for this PC itself (testing an update before publishing it).
    return parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1")


class _Redirects(urllib.request.HTTPRedirectHandler):
    """GitHub answers a private download with a redirect to its file store,
    which refuses a request that still carries the token - and the token is
    for GitHub's API alone."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and urllib.parse.urlparse(newurl).hostname != TOKEN_HOST:
            new.headers.pop("Authorization", None)
        return new


_OPENER = urllib.request.build_opener(_Redirects)


def _limited(err):
    """Whether GitHub refused because this network asked too often."""
    return err.code == 429 or (err.code == 403 and err.headers.get("X-RateLimit-Remaining") == "0")


def open_url(url, token="", accept=""):
    """Open an address. `token` (a GitHub access token) goes along only to
    api.github.com; `accept` replaces the Accept header."""
    if not allowed(url):
        raise UpdateError("The update address must start with https://")
    headers = dict(_HEADERS)
    if accept:
        headers["Accept"] = accept
    if token and urllib.parse.urlparse(url).hostname == TOKEN_HOST:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, headers=headers)
    try:
        return _OPENER.open(req, timeout=TIMEOUT)
    except urllib.error.HTTPError as err:
        if _limited(err):
            raise UpdateError("GitHub is turning away update checks from this network for now "
                              "(too many in the last hour). Try again later.", err.code)
        if err.code == 401:
            raise UpdateError("GitHub didn't accept the access token (it may have expired). "
                              "Replace it in Settings > Updates.", 401)
        raise UpdateError(f"The update address answered {err.code} for {url[:160]}. Check it in Settings > Updates.",
                          err.code)
    except (urllib.error.URLError, OSError) as err:
        raise UpdateError(f"Couldn't reach the update address ({getattr(err, 'reason', err)}).")
