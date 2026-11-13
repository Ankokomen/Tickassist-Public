"""A small route table. Each api/ module declares its routes:

    routes = Routes()

    @routes.get(r"/api/tickets/(\\d+)")
    def get_ticket(app, req, ticket_id): ...

    @routes.post("/api/photos", feature="photos")
    def add_photo(app, req): ...

A route function returns a Response, or a dict/list that is sent as JSON.
`feature` refuses the route with 403 while that feature is switched off.
Errors the services raise are turned into answers in one place (ERRORS, plus
whatever the modules' owner hands the Router).
"""

import re
import sys
import traceback

from ..domain.lists import UnknownList
from ..services import llm, transfer
from ..services.d365 import D365Error
from ..services.lists import FixedList, NotVerifiable
from ..services.update import Busy, UpdateError
from ..storage.errors import ListItemExistsError, MacroExistsError
from .http import HttpError, Response


class Route:
    def __init__(self, method, pattern, func, feature):
        self.method = method
        self.regex = re.compile(pattern)
        self.func = func
        self.feature = feature


class Routes:
    def __init__(self):
        self.items = []

    def add(self, method, pattern, feature=None):
        def register(func):
            self.items.append(Route(method, pattern, func, feature))
            return func
        return register

    def get(self, pattern, feature=None):
        return self.add("GET", pattern, feature)

    def post(self, pattern, feature=None):
        return self.add("POST", pattern, feature)

    def put(self, pattern, feature=None):
        return self.add("PUT", pattern, feature)

    def delete(self, pattern, feature=None):
        return self.add("DELETE", pattern, feature)


# Exception type -> (status, message or None for str(err)). Checked in order,
# so subclasses go before their bases. Errors that carry their own status
# (D365Error, TransferError, HttpError) are handled before this table.
ERRORS = [
    (UnknownList, 404, "Unknown list."),
    (NotVerifiable, 404, None),
    (FixedList, 403, None),
    (ListItemExistsError, 409, None),
    (MacroExistsError, 409, None),
    (Busy, 409, None),
    (UpdateError, 502, None),
    (llm.LLMError, 502, None),
    (ValueError, 400, None),
]


class Router:
    def __init__(self, app, *modules, errors=()):
        self.app = app
        self.routes = [r for m in modules for r in m.routes.items]
        self.errors = list(errors) + ERRORS

    def dispatch(self, req):
        found = None
        for route in self.routes:
            if route.method != req.method:
                continue
            m = route.regex.fullmatch(req.path)
            if m:
                found = (route, m.groups())
                break
        if not found:
            return Response.error("Not found.", 404)
        route, args = found
        if route.feature and not self.app.feature_on(route.feature):
            label = self.app.features.labels[route.feature]
            return Response.error(f"{label} is turned off in Settings > Features.", 403)
        try:
            result = route.func(self.app, req, *args)
        except Exception as err:      # noqa: BLE001 - every failure gets an answer
            return self.failure(err)
        return result if isinstance(result, Response) else Response.json(result)

    def failure(self, err):
        if isinstance(err, HttpError):
            return Response.error(str(err), err.status, **err.extra)
        if isinstance(err, D365Error):
            extra = {"signed_out": True} if err.signed_out else {}
            return Response.error(str(err), err.status, **extra)
        if isinstance(err, transfer.TransferError):
            return Response.error(str(err), err.status)
        for kind, status, message in self.errors:
            if isinstance(err, kind):
                return Response.error(message or str(err), status)
        traceback.print_exception(err, file=sys.stdout)
        return Response.error("TickAssist ran into a problem: %s" % err, 500)
