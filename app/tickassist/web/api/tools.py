"""Note Generator helpers: AI Polish, Google Sheet lookups, server reports."""

from ...services import llm, serverinfo, sheets
from ..http import HttpError
from ..router import Routes

routes = Routes()


@routes.post("/api/polish", feature="polish")
def polish(app, req):
    return {"result": llm.polish(req.json(), app.settings.all())}


@routes.get("/api/sheet/lookup", feature="sheet")
def sheet_lookup(app, req):
    try:
        results = sheets.lookup_everywhere(app.settings.all(), req.arg("field", "imaging_package"),
                                           req.arg("key"), req.arg("prefer"))
    except sheets.SheetError as err:
        raise HttpError(502, str(err))
    if results is None:
        return {"configured": False, "results": []}
    return {"configured": True, "results": results}


@routes.post("/api/sheet/test", feature="sheet")
def sheet_test(app, req):
    return sheets.test_with(app.settings.all(), req.json())


@routes.post("/api/serverinfo/parse")
def parse_server_report(app, req):
    text = str(req.json().get("text") or "")[:200000]
    return serverinfo.parse(text, app.settings.get("report_rules") or "")
