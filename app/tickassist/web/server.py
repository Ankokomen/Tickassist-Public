"""The HTTP server: standard-library ThreadingHTTPServer, localhost only."""

import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from . import pages
from .api import calls, d365, lists, photos, roster, settings, tickets, tools, updates
from .http import Request
from .router import Router

MODULES = (pages, settings, tickets, photos, lists, calls, d365, tools, roster, updates)

# Successful requests not worth a console line: static files, and the
# incoming-call long-poll that re-asks every 25 s all shift.
QUIET_PREFIXES = ("/static/",)
QUIET_PATHS = ("/favicon.ico", "/api/incoming")


def make_handler(router, version):
    class Handler(BaseHTTPRequestHandler):
        server_version = "TickAssist/" + version

        def _handle(self):
            req = Request(self.command, self.path, self.headers, self.rfile,
                          self.server.server_address[1])
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
