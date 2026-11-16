"""Program updates.

    common.py     the error type, version numbers, fetching
    sources.py    finding versions: the GitHub Releases of the update repository
    installer.py  downloading, verifying, installing and rolling back

Updates (below) is what the rest of the program uses: which address to ask,
whether a restart is pending, and the automatic update at start-up.
"""

import os
import subprocess
import sys
import threading
import time

from . import installer, sources
from .common import UpdateError, is_newer, parse_version  # noqa: F401  (UpdateError: callers catch it from here)

PUBLIC_URL = "https://github.com/Ankokomen/Tickassist-Public"
# A slow or missing network never holds start-up longer than this.
STARTUP_WAIT_SECONDS = 10
# The page asks on every load and start-up asks too; GitHub allows a network
# 60 unsigned questions an hour. An answer this fresh is reused, except by
# the Check for updates button.
CHECK_KEEP_SECONDS = 300


class Busy(Exception):
    """An update is already installed and waiting for a restart (HTTP 409)."""


def _same(url):
    return url.strip().rstrip("/").lower().removesuffix(".git")


class Updates:
    product = "TickAssist"       # names the update zip: <product>-<version>-update.zip
    default_url = PUBLIC_URL
    # Earlier versions saved these addresses (old defaults); they count as "not set".
    retired_urls = ("https://github.com/ankokomen/tickassist-updates",
                    "https://github.com/ankokomen/tickassist")

    def __init__(self, config, settings):
        self.config = config
        self.settings = settings
        self._checked = None     # (when, address, token, answer)
        # The version this process started as. If the VERSION file says
        # otherwise, an update was installed while running: the new pages are
        # served by the old program until a restart.
        self.started_version = config.version()
        self.auto_message = ""

    # ---- state ---------------------------------------------------------------
    def current(self):
        return self.config.version()

    def restart_needed(self):
        return self.current() != self.started_version

    def url(self):
        """Where this copy updates from: its own repository, unless the office
        file (app/owner.json) names another. It is not a PC's to change: an
        address a PC saved before 6.6 is ignored."""
        value = (self.settings.office.get("update_url") or "").strip()
        try:
            sources.repository(value)
        except UpdateError:
            value = ""
        if _same(value) in [_same(u) for u in self.retired_urls]:
            value = ""
        return value or self.default_url

    def token(self):
        """The access token for a private update repository; usually none."""
        return (self.settings.get("update_token") or "").strip()

    def _ensure_not_pending(self, message):
        if self.restart_needed():
            raise Busy(message)

    # ---- what the Updates panel does --------------------------------------------
    def check(self, fresh=True):
        """The newest published version. fresh=False accepts an answer from
        the last few minutes."""
        url, token, now = self.url(), self.token(), time.monotonic()
        kept = self._checked
        if not fresh and kept and kept[1:3] == (url, token) and now - kept[0] < CHECK_KEEP_SECONDS:
            info = dict(kept[3], current=self.current())
            info["newer"] = is_newer(info["latest"], info["current"])
            return info
        info = sources.check(url, self.current(), self.product, token)
        self._checked = (now, url, token, dict(info))
        return info

    def install_latest(self):
        self._ensure_not_pending("An update is already installed - restart TickAssist to use it.")
        info = self.check()
        if not info["newer"]:
            raise Busy(f"Already up to date (version {info['current']}).")
        return self._apply(info)

    def versions(self):
        return sources.versions(self.url(), self.product, self.token())

    def install_version(self, want):
        """Install a listed version, newer or older. Going back also turns off
        "update when TickAssist starts", or the next start would upgrade again.
        None when the version isn't published."""
        self._ensure_not_pending("An update is already installed - restart TickAssist first.")
        want = str(want or "").strip().lstrip("vV")
        pick = next((i for i in self.versions() if i["version"] == want), None)
        if not pick:
            return None
        info = {"zip_url": pick["zip_url"], "sha256": pick["sha256"], "latest": pick["version"]}
        older = parse_version(want) < parse_version(self.current())
        result = self._apply(info, allow_older=True)
        if older:
            self.settings.update({"auto_update": "0"})
        result["auto_update_off"] = older
        return result

    def _apply(self, info, allow_older=False):
        return installer.apply(info, self.config.root_dir, self.config.data_dir, self.current(),
                               allow_older=allow_older, extension=self.config.dev, token=self.token())

    # ---- at start-up -----------------------------------------------------------
    def auto_update_wanted(self):
        return str(self.settings.get("auto_update")) == "1"

    def update_at_startup(self):
        """Install a newer published version before anything opens. True when
        one was installed (the caller restarts). Offline, a bad address or a
        bad zip just means starting normally; a slow network is given up on
        after STARTUP_WAIT_SECONDS and the check carries on in the background."""
        box = {}

        def run():
            try:
                info = self.check()
                if not info["newer"]:
                    return
                result = self._apply(info)
            except Exception as err:      # noqa: BLE001 - never stop start-up
                self.auto_message = "Automatic update didn't run: %s" % err
                print("  " + self.auto_message)
                return
            self.auto_message = "Updated automatically from %s to %s." % (result.get("old"), result.get("new"))
            box["done"] = True

        worker = threading.Thread(target=run, daemon=True, name="autoupdate")
        worker.start()
        worker.join(STARTUP_WAIT_SECONDS)
        return bool(box.get("done"))


def restart(config, browser=False, updated_from=""):
    """Start a fresh copy of TickAssist, then end this one. The new copy waits
    for the port to come free and the page reloads itself. browser=True lets
    the new copy open the page; updated_from marks it as just updated, so it
    does not update again."""
    extra = ("" if browser else "--no-browser ") + "--restarted"
    if updated_from:
        extra += " --updated=" + updated_from
    if os.name == "nt" and os.path.exists(config.launcher):
        subprocess.Popen('start "TickAssist" /min "%s" %s' % (config.launcher, extra),
                         shell=True, cwd=config.root_dir)
    else:
        keep = [a for a in sys.argv
                if a not in ("--restarted", "--no-browser") and not a.startswith("--updated")]
        subprocess.Popen([sys.executable] + keep + extra.split(), cwd=config.root_dir)
    threading.Timer(0.6, lambda: os._exit(0)).start()
