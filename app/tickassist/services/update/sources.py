"""Finding versions: the GitHub Releases of the update repository.

A release is one version: its tag is the version number ("v6.4" or "6.4"),
its body is the release notes, and its assets are the build outputs of
tools/build.py. A PC installs the update zip, TickAssist-<version>-update.zip.
GitHub publishes each asset's SHA-256 ("digest"), which the installer checks.
Drafts and pre-releases are never offered.

Both functions return what installer.apply() takes:
    {"latest" | "version", "zip_url", "sha256", "notes"}
"""

import json
import re
import urllib.parse

from .common import UpdateError, is_newer, open_url, parse_version

API = "https://api.github.com"


def repository(url):
    """(owner, repo) from a github.com address - the repository page, its
    /releases page, a .git clone address or an api.github.com address."""
    parts = urllib.parse.urlparse((url or "").strip())
    bits = [b for b in parts.path.split("/") if b]
    if parts.hostname == "api.github.com" and len(bits) >= 3 and bits[0] == "repos":
        bits = bits[1:]
    if parts.hostname not in ("github.com", "www.github.com", "api.github.com") or len(bits) < 2:
        raise UpdateError("The update address must be a GitHub repository, "
                          "like https://github.com/<owner>/<repo>.")
    return bits[0], bits[1].removesuffix(".git")


def _get(path):
    with open_url(API + path) as resp:
        raw = resp.read(4 * 1024 * 1024)
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:
        raise UpdateError("GitHub answered with something that isn't a release list.")


def asset_name(version):
    return "TickAssist-%s-update.zip" % version


def _pick(release):
    """The update zip in a release, or None."""
    version = str(release.get("tag_name") or "").lstrip("vV")
    assets = [a for a in release.get("assets") or [] if isinstance(a, dict)]
    want = asset_name(version).lower()
    asset = next((a for a in assets if str(a.get("name", "")).lower() == want), None)
    if asset is None:
        return None
    digest = str(asset.get("digest") or "")
    return {"version": version, "latest": version,
            "zip_url": asset.get("browser_download_url"),
            "sha256": digest.split(":", 1)[1].lower() if digest.startswith("sha256:") else "",
            "notes": str(release.get("body") or "")}


def _offered(release):
    return isinstance(release, dict) and not release.get("draft") and not release.get("prerelease")


def check(url, current):
    """The newest release: {"latest", "current", "newer", "zip_url", "sha256", "notes"}."""
    owner, repo = repository(url)
    try:
        release = _get(f"/repos/{owner}/{repo}/releases/latest")
    except UpdateError as err:
        if err.status == 404:
            raise UpdateError("No release of %s/%s is published yet (or the repository isn't public)."
                              % (owner, repo))
        raise
    found = _pick(release) if _offered(release) else None
    if not found or not found["zip_url"]:
        raise UpdateError("The newest release of %s/%s has no %s file." % (
            owner, repo, asset_name(str(release.get("tag_name") or "<version>").lstrip("vV"))))
    if not re.search(r"\d", found["version"]):
        raise UpdateError("The newest release's tag (%s) isn't a version number." % release.get("tag_name"))
    return {"latest": found["version"], "current": current,
            "newer": is_newer(found["version"], current), "zip_url": found["zip_url"],
            "sha256": found["sha256"], "notes": found["notes"][:2000]}


def versions(url):
    """Every published version with an update zip, newest first:
    [{"version", "zip_url", "sha256", "notes"}]."""
    owner, repo = repository(url)
    releases = _get(f"/repos/{owner}/{repo}/releases?per_page=100")
    out = []
    for release in releases if isinstance(releases, list) else []:
        found = _pick(release) if _offered(release) else None
        if found and found["zip_url"]:
            out.append({"version": found["version"], "zip_url": found["zip_url"],
                        "sha256": found["sha256"], "notes": found["notes"][:500]})
    if not out:
        raise UpdateError("%s/%s has no published releases yet." % (owner, repo))
    out.sort(key=lambda i: parse_version(i["version"]), reverse=True)
    return out
