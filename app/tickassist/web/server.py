"""The HTTP server: standard-library ThreadingHTTPServer, localhost only."""

import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from . import pages
from .api import calls, d365, lists, photos, roster, settings, tickets, tools, updates
from .http import Request, Response
from .router import Router

MODULES = (pages, settings, tickets, photos, lists, calls, d365, tools, roster, updates)

# Successful requests not worth a console line: static files, and the
# incoming-call long-poll that re-asks every 25 s all shift.
QUIET_PREFIXES = ("/static/",)
QUIET_PATHS = ("/favicon.ico", "/api/incoming")


def make_handler(router, version):
    class Handler(BaseHTTPRequestHandler):
        server_version = "TickAssist/" + version

        def _ours(self):
            """Whether the request is for this program and from its own page.
            Any web page can make the browser send a request to localhost;
            what it cannot do is hide where it came from. So: the address
            asked for must be this PC (a name that merely points here is
            someone else's site), and anything that changes something must
            not come from another site's page."""
            port = self.server.server_address[1]
            names = {"%s:%d" % (name, port) for name in ("localhost", "127.0.0.1", "[::1]")}
            if (self.headers.get("Host") or "").strip().lower() not in names:
                return False
            origin = (self.headers.get("Origin") or "").strip().lower()
            if self.command != "GET" and origin and origin not in {"http://" + name for name in names}:
                return False
            return True

        def _handle(self):
            if not self._ours():
                res = Response.error("This address only answers TickAssist's own page.", 403)
            else:
                try:
                    req = Request(self.command, self.path, self.headers, self.rfile,
                                  self.server.server_address[1])
                except ValueError:              # an address that cannot be read
                    res = Response.error("Bad request.", 400)
                else:
                    res = router.dispatch(req)
            self.send_response(res.status)
            for name, value in res.headers:
                self.send_header(name, value)
            if res.body is not None:
                self.send_header("Content-Length", str(len(res.body)))
            self.end_headers()
            if res.body:
                self.wfile.write(res.body)

        do_GET = do_POST = do_PUT = do_DELETE = _handle

        def log_request(self, code="-", size="-"):
            path = urlparse(getattr(self, "path", "")).path
            if str(code) in ("200", "201", "304") and (
                    path.startswith(QUIET_PREFIXES) or path in QUIET_PATHS):
                return
            super().log_request(code, size)

        def log_message(self, fmt, *args):
            sys.stdout.write("  %s - %s\n" % (self.address_string(), fmt % args))

    return Handler


class Server(ThreadingHTTPServer):
    # Long-polls park a thread each; they must not keep the process alive.
    daemon_threads = True
    # On Windows "reuse the address" means binding over a port something is
    # still listening on - a second TickAssist would then share this one's.
    allow_reuse_address = os.name != "nt"
    # The page asks for all of its modules at once. With the default queue of
    # 5, Windows refuses the connections that don't fit and the page loads
    # without its script.
    request_queue_size = 128

    def handle_error(self, request, client_address):
        # The browser went away before the answer was all sent (a reload, a
        # closed tab, a long-poll it gave up on): nothing went wrong here.
        if isinstance(sys.exc_info()[1], ConnectionError):
            return
        super().handle_error(request, client_address)


def make_server(app, host, port):
    modules, errors = MODULES, ()
    if app.config.dev:
        from .. import dev
        modules, errors = MODULES + dev.MODULES, dev.ERRORS
    router = Router(app, *modules, errors=errors)
    return Server((host, port), make_handler(router, app.updates.started_version))
