"""Request and response objects, so route functions never touch the socket."""

import json
from urllib.parse import parse_qs, urlparse

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".json": "application/json; charset=utf-8",
}
HTML = CONTENT_TYPES[".html"]


class HttpError(Exception):
    """Stop handling and answer {"error": message, **extra} with this status."""

    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status = status
        self.extra = extra


class Request:
    def __init__(self, method, target, headers, rfile, server_port):
        parts = urlparse(target)
        self.method = method
        self.path = parts.path
        self.query = parse_qs(parts.query)
        self.headers = headers
        self.server_port = server_port
        self._rfile = rfile
        self._json = None

    def arg(self, name, default=""):
        """The first ?name= value."""
        return (self.query.get(name) or [default])[0]

    def int_arg(self, name):
        raw = self.arg(name)
        return int(raw) if raw.isascii() and raw.isdigit() else None

    @property
    def length(self):
        return int(self.headers.get("Content-Length") or 0)

    @property
    def content_type(self):
        return (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()

    def body(self):
        return self._rfile.read(self.length) if self.length > 0 else b""

    def chunks(self, size=1024 * 1024):
        """The body in pieces, for uploads too big to hold in memory."""
        left = self.length
        while left > 0:
            chunk = self._rfile.read(min(left, size))
            if not chunk:
                break
            left -= len(chunk)
            yield chunk

    def json(self):
        """The body as a JSON object ({} when empty)."""
        if self._json is None:
            raw = self.body()
            if not raw:
                self._json = {}
            else:
                try:
                    data = json.loads(raw.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    raise ValueError("Request body was not valid JSON.")
                if not isinstance(data, dict):
                    raise ValueError("Request body must be a JSON object.")
                self._json = data
        return self._json


class Response:
    def __init__(self, body=b"", status=200, content_type="application/octet-stream", headers=None):
        self.body = body
        self.status = status
        self.headers = [("Content-Type", content_type)] if content_type else []
        self.headers += list(headers or [])

    @classmethod
    def json(cls, payload, status=200):
        return cls(json.dumps(payload).encode("utf-8"), status, "application/json; charset=utf-8")

    @classmethod
    def error(cls, message, status=400, **extra):
        return cls.json(dict({"error": message}, **extra), status)

    @classmethod
    def html(cls, text, status=200):
        return cls(text.encode("utf-8"), status, HTML)

    @classmethod
    def redirect(cls, location):
        return cls(b"", 302, None, [("Location", location)])

    @classmethod
    def download(cls, body, filename, content_type="application/octet-stream"):
        return cls(body, 200, content_type,
                   [("Content-Disposition", f'attachment; filename="{filename}"')])

    @classmethod
    def not_modified(cls, headers):
        return cls(None, 304, None, headers)
