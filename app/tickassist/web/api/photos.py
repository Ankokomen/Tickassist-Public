"""Photos kept with a ticket (or with the unsaved form, as drafts)."""

import re

from ..http import HttpError, Response
from ..router import Routes

routes = Routes()

# Photos are resized in the browser before upload; this only stops a mistake.
MAX_UPLOAD = 25 * 1024 * 1024
TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"}


def _scope(req):
    """?ticket=ID for a saved ticket; anything else is the draft set."""
    return req.int_arg("ticket")


@routes.get("/api/photos", feature="photos")
def list_photos(app, req):
    return {"photos": app.store.tickets.photos(_scope(req))}


@routes.post("/api/photos", feature="photos")
def add_photo(app, req):
    if req.content_type not in TYPES:
        raise HttpError(400, "Photos must be PNG, JPEG, GIF, WebP or BMP.")
    if req.length <= 0:
        raise HttpError(400, "No photo was uploaded.")
    if req.length > MAX_UPLOAD:
        raise HttpError(400, "That photo is %.1f MB, over the %d MB limit."
                        % (req.length / 1048576.0, MAX_UPLOAD // 1048576))
    photo = app.store.tickets.add_photo(_scope(req), req.arg("name"), req.content_type,
                                        req.body(), req.int_arg("w"), req.int_arg("h"))
    if not photo:
        raise HttpError(404, "Ticket not found.")
    return {"photo": photo}


@routes.get(r"/api/photos/(\d+)", feature="photos")
def get_photo(app, req, photo_id):
    photo = app.store.tickets.photo(int(photo_id))
    if not photo:
        raise HttpError(404, "Photo not found.")
    headers = [("Cache-Control", "private, max-age=86400")]        # photos never change
    if req.arg("download", "0") == "1":
        name = req.arg("name") or photo["name"] or "photo-%s" % photo_id
        safe = re.sub(r'[^A-Za-z0-9._ -]+', "_", name).strip() or "photo"
        headers.append(("Content-Disposition", 'attachment; filename="%s"' % safe))
    return Response(bytes(photo["data"]), 200, photo["mime"], headers)


@routes.delete(r"/api/photos/(\d+)", feature="photos")
def delete_photo(app, req, photo_id):
    if not app.store.tickets.delete_photo(int(photo_id)):
        raise HttpError(404, "Photo not found.")
    return {"deleted": True}


@routes.post("/api/photos/claim", feature="photos")
def claim_drafts(app, req):
    return {"claimed": app.store.tickets.claim_drafts(int(req.json().get("ticket_id") or 0))}


@routes.post("/api/photos/copy", feature="photos")
def copy_photos(app, req):
    data = req.json()
    return {"copied": app.store.tickets.copy_photos(int(data.get("from") or 0), int(data.get("to") or 0))}


@routes.post("/api/photos/discard-drafts", feature="photos")
def discard_drafts(app, req):
    return {"deleted": app.store.tickets.discard_drafts()}
