"""Incoming calls from MAX, the screen-pop route, and transferring a call."""

from ...services import transfer
from ...services.callwatch.browser import launch_max
from ..http import Response
from ..router import Routes

routes = Routes()

# How long one /api/incoming request is held open waiting for a call: well
# inside any browser or proxy timeout.
INCOMING_HOLD_SECONDS = 25

_POP_PAGE = ("<!doctype html><meta charset=utf-8><title>TickAssist</title>"
             "<p style='font:14px sans-serif'>%s</p>")


@routes.get("/api/incoming")
def incoming(app, req):
    """Long-poll: answer as soon as a call newer than ?since= arrives. Without
    ?since= it answers at once with the current sequence, which is how a
    freshly loaded page learns where "now" is without replaying an old call."""
    raw = req.arg("since")
    seq, event = app.calls.wait(int(raw) if raw.isdigit() else None, INCOMING_HOLD_SECONDS)
    return {"seq": seq, "event": event, "watch": app.calls.status()}


@routes.get("/call", feature="calls")
def screen_pop(app, req):
    """For a CXone Studio POPURL / RUNAPP action, e.g.
        http://localhost:8765/call?phone={ANI}&skill={SKILLNAME}&contactId={CONTACTID}
    ?skill= sets Contact Type through the caller-type rules; ?case= (or
    ?caseNumber=) passes a CAS0490097 case number. ?ani= is what the CXone
    call page itself uses. The reply is a tiny page, since MAX may show it."""
    ev = app.calls.screen_pop(req.arg("phone") or req.arg("ani"), skill=req.arg("skill"),
                              case=req.arg("case") or req.arg("caseNumber"),
                              contact_id=req.arg("contactId"))
    if ev is None:
        return Response.html(_POP_PAGE % "TickAssist: no usable phone number in <code>?phone=</code>.", 400)
    return Response.html(_POP_PAGE % ("Sent <b>%s</b> to TickAssist." % ev["phone"]))


@routes.post("/api/callwatch/open-max", feature="calls")
def open_max(app, req):
    """Start Chrome/Edge on MAX with background reading on."""
    data = req.json()
    settings = app.settings.all()
    url = (data.get("max_url") or settings.get("max_url") or "").strip()
    prefer = data.get("max_browser") or settings.get("max_browser") or "auto"
    result = launch_max(url, app.config.data_dir, prefer if prefer in ("auto", "chrome", "edge") else "auto")
    return Response.json(result, 200 if result.get("ok") else 500)


@routes.post("/api/callwatch/refresh", feature="calls")
def refresh(app, req):
    return {"restarted": app.calls.refresh(), "watch": app.calls.status()}


@routes.post("/api/callwatch/test", feature="calls")
def test_call(app, req):
    return {"event": app.calls.test(), "watch": app.calls.status()}


@routes.get("/api/transfer/config", feature="transfer")
def transfer_config(app, req):
    return {"equipment": transfer.config(), "configured": bool(transfer.url_for(app.settings.all()))}


@routes.post("/api/transfer", feature="transfer")
def transfer_call(app, req):
    return transfer.send(transfer.url_for(app.settings.all()), req.json(), app.config.data_dir)
