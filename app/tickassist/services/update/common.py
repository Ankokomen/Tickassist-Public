"""What every part of updating shares: the error type, version numbers and
fetching from a web address."""

import re
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT = 20
_HEADERS = {"User-Agent": "TickAssist-updater", "Accept": "application/json, application/zip, */*"}


class UpdateError(Exception):
    """A problem the user can act on. `status` is the HTTP status the update
    server answered with, when that was the problem."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def parse_version(text):
    return tuple(int(n) for n in re.findall(r"\d+", str(text or ""))[:4]) or (0,)


def is_newer(latest, current):
    a, b = parse_version(latest), parse_version(current)
    width = max(len(a), len(b))
    return a + (0,) * (width - len(a)) > b + (0,) * (width - len(b))


def allowed(url):
    parts = urllib.parse.urlparse(url)
    if parts.scheme == "https":
        return True
    # Plain http only for this PC itself (testing an update before publishing it).
    return parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1")


def open_url(url):
    if not allowed(url):
        raise UpdateError("The update address must start with https://")
    req = urllib.request.Request(url, headers=_HEADERS)
    try:
        return urllib.request.urlopen(req, timeout=TIMEOUT)
    except urllib.error.HTTPError as err:
        raise UpdateError(f"The update address answered {err.code} for {url[:160]}. Check it in Settings > Updates.",
                          err.code)
    except (urllib.error.URLError, OSError) as err:
        raise UpdateError(f"Couldn't reach the update address ({getattr(err, 'reason', err)}).")
