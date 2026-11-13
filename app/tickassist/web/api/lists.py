"""The dropdown lists and the shorthand macros (Settings > Lists & Macros)."""

from ..http import HttpError, Response
from ..router import Routes

routes = Routes()


@routes.get("/api/lists/([a-z_]+)")
def get_list(app, req, key):
    return app.lists.describe(key)


@routes.get("/api/lists/([a-z_]+)/verify")
def verify_value(app, req, key):
    return app.lists.verify(key, req.arg("value"))


@routes.post("/api/lists/sync")
def import_from_sheets(app, req):
    return app.lists.import_from_sheets()


@routes.post("/api/lists/([a-z_]+)")
def add_item(app, req, key):
    return Response.json({"item": app.lists.add(key, req.json().get("name", ""))}, 201)


@routes.delete(r"/api/lists/([a-z_]+)/(\d+)")
def delete_item(app, req, key, item_id):
    if not app.lists.delete(key, int(item_id)):
        raise HttpError(404, "Item not found.")
    return {"deleted": True}


@routes.get("/api/macros")
def list_macros(app, req):
    return {"macros": app.store.macros.all()}


@routes.post("/api/macros")
def add_macro(app, req):
    data = req.json()
    return Response.json({"macro": app.store.macros.add(data.get("trigger", ""),
                                                         data.get("expansion", ""))}, 201)


@routes.delete(r"/api/macros/(\d+)")
def delete_macro(app, req, macro_id):
    if not app.store.macros.delete(int(macro_id)):
        raise HttpError(404, "Macro not found.")
    return {"deleted": True}
