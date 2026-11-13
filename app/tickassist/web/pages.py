"""The page shell and its static files.

Fonts never change, so they are cached for a year; everything else is
no-cache + Last-Modified, which turns repeat loads into cheap 304s while
still picking up a new version immediately.
"""

import os
import re
from email.utils import formatdate, parsedate_to_datetime

from .http import CONTENT_TYPES, HTML, Response
from .router import Routes

routes = Routes()

IMMUTABLE = (".woff2", ".woff")
# Places in the shell where a copy with the dev package adds to the page:
# a line holding only <!-- slot:name -->. Otherwise the line goes.
SLOT = re.compile(r"^[ \t]*<!-- slot:([a-z]+) -->[ \t]*\r?\n", re.M)


def _not_modified(req, mtime):
    ims = req.headers.get("If-Modified-Since")
    if not ims:
        return False
    try:
        return int(mtime) <= parsedate_to_datetime(ims).timestamp()
    except (TypeError, ValueError):
        return False


def _newest(paths):
    times = []
    for path in paths:
        try:
            times.append(os.path.getmtime(path))
        except OSError:
            pass
    return max(times)


@routes.get(r"/|/index\.html")
def index(app, req):
    """The page shell with {{VERSION}} filled in. Its freshness spans the
    template and the VERSION file - bumping the version alone would otherwise
    leave the browser on a 304."""
    path = app.config.page_file
    if not os.path.isfile(path):
        return Response.error("Template missing.", 500)
    sources = [path, app.config.version_file]
    page = None
    if app.config.dev:
        from ..dev import page
        sources += page.files(app.config)
    mtime = _newest(sources)
    cache = [("Cache-Control", "no-cache"), ("Last-Modified", formatdate(mtime, usegmt=True))]
    if _not_modified(req, mtime):
        return Response.not_modified(cache)
    with open(path, "r", encoding="utf-8") as fh:
        html = fh.read()
    html = html.replace("{{VERSION}}", app.updates.current())
    html = page.extend(html, app.config) if page else SLOT.sub("", html)
    return Response(html.encode("utf-8"), 200, HTML, cache)


@routes.get(r"/favicon\.ico")
def favicon(app, req):
    return static(app, req, "favicon.ico")


@routes.get(r"/static/(.+)")
def static(app, req, rel_path):
    root = os.path.normpath(app.config.static_dir)
    full = os.path.normpath(os.path.join(root, rel_path.replace("\\", "/").lstrip("/")))
    if not full.startswith(root + os.sep):
        return Response.error("Forbidden.", 403)
    try:
        stat = os.stat(full)
    except OSError:
        return Response.error("Not found.", 404)
    if not os.path.isfile(full):
        return Response.error("Not found.", 404)
    ext = os.path.splitext(full)[1].lower()
    cache = [("Cache-Control", "public, max-age=31536000, immutable" if ext in IMMUTABLE else "no-cache"),
             ("Last-Modified", formatdate(stat.st_mtime, usegmt=True))]
    if _not_modified(req, stat.st_mtime):
        return Response.not_modified(cache)
    with open(full, "rb") as fh:
        body = fh.read()
    return Response(body, 200, CONTENT_TYPES.get(ext, "application/octet-stream"), cache)
