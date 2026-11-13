"""Tickets: saving, reading, and finding the earlier ones from a phone number."""

from ..http import HttpError, Response
from ..router import Routes

routes = Routes()


def _ticket_or_404(ticket):
    if not ticket:
        raise HttpError(404, "Ticket not found.")
    return {"ticket": ticket}


@routes.post("/api/tickets")
def create_ticket(app, req):
    return Response.json({"ticket": app.store.tickets.create(req.json())}, 201)


@routes.get(r"/api/tickets/(\d+)")
def get_ticket(app, req, ticket_id):
    return _ticket_or_404(app.store.tickets.get(int(ticket_id)))


@routes.put(r"/api/tickets/(\d+)")
def update_ticket(app, req, ticket_id):
    return _ticket_or_404(app.store.tickets.update(int(ticket_id), req.json()))


@routes.delete(r"/api/tickets/(\d+)")
def delete_ticket(app, req, ticket_id):
    if not app.store.tickets.delete(int(ticket_id)):
        raise HttpError(404, "Ticket not found.")
    return {"deleted": True}


@routes.get("/api/tickets/lookup")
def repeat_caller(app, req):
    return {"matches": app.store.tickets.by_phone(req.arg("phone"))}


@routes.get("/api/tickets/callcard")
def call_card(app, req):
    return app.store.tickets.caller_card(req.arg("phone"))
