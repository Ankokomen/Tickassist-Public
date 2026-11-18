"""Starting TickAssist.

    server.py                 start (or focus the copy already running)
    server.py --no-browser    don't open the page
    server.py --no-update     skip the automatic update at start-up
    server.py --open-max      open MAX in a browser TickAssist can read, then exit
    server.py --no-tray       no icon by the clock

Started without a console (run.bat does, with pythonw.exe) what would have
been printed goes to tickassist.log in the data folder, and the icon by the
clock (tray.py) is where the program is opened, restarted and quit from.
    --restarted / --updated=  set by a restart after an update
"""

import json
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser

from . import config as config_module
from .config import HOST, PREFERRED_PORT

# Loopback probes must bypass any corporate proxy.
_LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _existing_instance(port, identity):
    """True if a TickAssist using OUR data answers on this port."""
    try:
        with _LOCAL.open(f"http://{HOST}:{port}/api/health", timeout=0.5) as resp:
            info = json.loads(resp.read().decode("utf-8"))
        return info.get("app") == "TickAssist" and info.get("db") == identity
    except Exception:      # noqa: BLE001 - anything else is "not us"
        return False


def _bindable(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        if os.name != "nt":   # a just-closed port (TIME_WAIT) is still usable; on
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)   # Windows this binds over a live one
        try:
            sock.bind((HOST, port))
            return True
        except OSError:
            return False


def find_port(identity):
    """(port, already_running): the first free port from 8765, or the port
    where this same TickAssist already runs, so it is focused, not doubled."""
    for port in range(PREFERRED_PORT, PREFERRED_PORT + 50):
        if _bindable(port):
            return port, False
        if _existing_instance(port, identity):
            return port, True
    raise SystemExit("Could not find a free port to bind to.")


def wait_for_port(seconds=15):
    """Started by a restart: the old copy is still closing."""
    deadline = time.time() + seconds
    while time.time() < deadline and not _bindable(PREFERRED_PORT):
        time.sleep(0.3)


def open_max(cfg):
    """"Open MAX.bat": start Chrome/Edge on MAX for the background reader."""
    from .services.callwatch.browser import launch_max
    from .services.owner import load, office_settings
    from .services.settings import Settings
    from .storage import open_settings_only
    settings = Settings(open_settings_only(cfg), office_settings(load(cfg.owner_file))).all()
    result = launch_max(settings.get("max_url", ""), cfg.data_dir, settings.get("max_browser", "auto"))
    print(result["message"])
    return 0 if result["ok"] else 1


LOG_NAME = "tickassist.log"
TRAY_ICON = "favicon.ico"           # TickAssist's mark (TA on blue and pink): the tab, the shortcuts, the tray
LOG_KEEP_BYTES = 1024 * 1024


def log_to_file(data_dir):
    """No console to print to: keep what would have been printed in the data
    folder instead (started afresh once it has grown large)."""
    try:
        os.makedirs(data_dir, exist_ok=True)
        path = os.path.join(data_dir, LOG_NAME)
        fresh = not os.path.exists(path) or os.path.getsize(path) > LOG_KEEP_BYTES
        out = open(path, "w" if fresh else "a", encoding="utf-8", buffering=1)
    except OSError:
        out = open(os.devnull, "w", encoding="utf-8")
    sys.stdout = sys.stderr = out
    print("---- TickAssist started %s ----" % time.strftime("%Y-%m-%d %H:%M:%S"))
    return out


def start_tray(app, cfg, url, httpd, argv):
    """The icon by the clock, or None (not Windows, switched off, or Windows
    would not show one - TickAssist runs all the same)."""
    if os.name != "nt" or "--no-tray" in argv or os.environ.get("TICKASSIST_TRAY", "").strip() == "0":
        return None
    from .services import update
    from .tray import Console, Tray
    console = Console(app, url, webbrowser.open, lambda: update.restart(cfg),
                      lambda: threading.Thread(target=httpd.shutdown, daemon=True).start())
    tray = Tray(console, os.path.join(cfg.static_dir, TRAY_ICON))
    if not tray.start():
        return None
    update.before_exit.append(tray.stop)       # a restart ends the process abruptly: take the icon along
    return tray


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    cfg = config_module.load()
    windowless = sys.stdout is None
    if windowless:
        log_to_file(cfg.data_dir)
    try:
        sys.stdout.reconfigure(line_buffering=True)    # prompt log lines even when piped
    except (AttributeError, ValueError):
        pass
    if "--open-max" in argv:
        return open_max(cfg)

    from .app import App
    from .services import owner as owner_file
    from .services.update import restart
    from .web.server import make_server

    browser = "--no-browser" not in argv
    if "--restarted" in argv:
        wait_for_port()
    owner_file.drop_password(cfg.owner_file)
    app = App(cfg)
    port, already_running = find_port(app.store.identity)
    url = f"http://{HOST}:{port}/"
    if already_running:
        print(f"TickAssist is already running at {url} - opening it.")
        if browser:
            webbrowser.open(url)
        return 0

    # A newer published version is installed before anything opens - except
    # right after an update (no loops), when switched off, or with --no-update.
    marker = next((a for a in argv if a.startswith("--updated")), "")
    if marker:
        app.updates.auto_message = "Updated automatically from %s." % (
            marker.partition("=")[2] or "the previous version")
    elif "--no-update" not in argv and app.updates.auto_update_wanted():
        old_version = app.updates.current()
        if app.updates.update_at_startup():
            print("  " + app.updates.auto_message + " Restarting...")
            restart(cfg, browser=browser, updated_from=old_version)
            time.sleep(5)
            return 0

    if app.apply_office_push():
        print("  Applied the owner's office settings and features to this PC.")

    httpd = make_server(app, HOST, port)
    app.configure_calls()
    print("=" * 56)
    print("  TickAssist - portable ticket handling")
    print("=" * 56)
    print(f"  Data     : {app.store.identity}")
    print(f"  Serving  : {url}")
    tray = start_tray(app, cfg, url, httpd, argv)
    print("  Quit from the TickAssist icon by the clock." if tray else "  Press Ctrl+C to stop.")
    print("=" * 56)
    if browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        if tray:
            tray.stop()
        app.shutdown()
        httpd.server_close()
    return 0
