"""Dynamics 365: the browser sign-in round trip, and the page's API calls."""

from ...services import d365
from ..http import Response
from ..router import Routes

routes = Routes()


def _result_page(title, message, ok=True):
    """What the sign-in tab shows when Microsoft sends it back here."""
    color = "#059669" if ok else "#dc2626"
    esc = lambda t: (t or "").replace("&", "&amp;").replace("<", "&lt;")
    page = ("<!doctype html><meta charset=utf-8><title>TickAssist - %s</title>"
            "<body style=\"font:15px system-ui,sans-serif;background:#0f172a;color:#e2e8f0;"
            "display:grid;place-items:center;height:100vh;margin:0\">"
            "<div style=\"max-width:520px;padding:28px;border:1px solid #334155;border-radius:12px\">"
            "<h2 style=\"margin:0 0 10px;color:%s\">%s</h2><p>%s</p>"
            "<p style=\"color:#94a3b8\">You can close this tab and go back to TickAssist.</p>"
            "</div><script>%s</script>"
            % (esc(title), color, esc(title), esc(message),
               "setTimeout(function(){window.close()},2500)" if ok else ""))
    return Response.html(page, 200 if ok else 400)


@routes.get("/d365/login", feature="d365")
def login(app, req):
    # Always "localhost": that is what the app registration lists, and Entra
    # ignores a localhost redirect's port, so 8766 works too.
    redirect = "http://localhost:%d%s" % (req.server_port, d365.CALLBACK_PATH)
    try:
        return Response.redirect(app.crm.begin_login(redirect))
    except d365.D365Error as err:
        return _result_page("Can't sign in yet", str(err), ok=False)


@routes.get(d365.CALLBACK_PATH, feature="d365")
def callback(app, req):
    try:
        name = app.crm.finish_login({k: v[0] for k, v in req.query.items()})
    except d365.D365Error as err:
        return _result_page("D365 sign-in failed", str(err), ok=False)
    return _result_page("Signed in to Dynamics 365",
                        "TickAssist is connected%s." % (" as " + name if name else ""))


@routes.get("/api/d365/status", feature="d365")
def status(app, req):
    return app.crm.status()


@routes.get("/api/d365/customers", feature="d365")
def customers(app, req):
    return {"matches": app.crm.find_customers(req.arg("phone"), req.arg("name"))}


@routes.get("/api/d365/case", feature="d365")
def find_case(app, req):
    return {"case": app.crm.find_case(req.arg("number"))}


@routes.post("/api/d365/signout", feature="d365")
def sign_out(app, req):
    app.crm.sign_out()
    return app.crm.status()


@routes.post("/api/d365/test", feature="d365")
def test(app, req):
    return {"user": app.crm.whoami(), "form": app.crm.case_form_info()}


@routes.post("/api/d365/case", feature="d365")
def create_case(app, req):
    return Response.json(d365.create_case_with_note(app.crm, app.store.tickets, req.json()), 201)


@routes.post("/api/d365/note", feature="d365")
def add_note(app, req):
    return Response.json(d365.add_note_to_case(app.crm, app.store.tickets, req.json()), 201)
