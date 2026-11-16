"""The tech roster sheet: check a caller against it, add a new one, test the link."""

from ...services import roster
from ..router import Routes

routes = Routes()


@routes.post("/api/roster/check", feature="roster")
def roster_check(app, req):
    data = req.json()
    settings = app.settings.all()
    if not roster.configured(settings):
        return {"result": "off"}
    return roster.check(settings, str(data.get("name") or ""), str(data.get("phone") or ""))


@routes.post("/api/roster/add", feature="roster")
def roster_add(app, req):
    data = req.json()
    return roster.add(app.settings.all(), str(data.get("name") or ""), str(data.get("phone") or ""),
                      str(data.get("dealer") or ""))


@routes.post("/api/roster/test", feature="roster")
def roster_test(app, req):
    return roster.test(app.settings.all(), req.json())


@routes.get("/api/roster/script", feature="roster")
def roster_script(app, req):
    return {"script": roster.SCRIPT}
