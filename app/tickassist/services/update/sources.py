"""Finding versions: the GitHub Releases of the update repository.

A release is one version: its tag is the version number ("v6.4" or "6.4"),
its body is the release notes, and its assets are the build outputs of
tools/build.py. A PC installs the update zip, <product>-<version>-update.zip,
where the product is what this copy is (TickAssist).
GitHub publishes each asset's SHA-256 ("digest"), which the installer checks.
Drafts and pre-releases are never offered. A private repository answers only
with an access token; its files then come through the API as well.

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


def _get(path, token=""):
    with open_url(API + path, token) as resp:
        raw = resp.read(4 * 1024 * 1024)
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:
        raise UpdateError("GitHub answered with something that isn't a release list.")


def _releases(owner, repo, path, token):
    """GitHub's answer about the repository's releases. It says 404 both for
    "nothing there" and for "not yours to see"."""
    try:
        return _get(f"/repos/{owner}/{repo}/{path}", token)
    except UpdateError as err:
        if err.status != 404:
            raise
        if token:
            raise UpdateError("%s/%s has no published release, or the access token can't read it "
                              "(it needs Contents: read on that repository)." % (owner, repo), 404)
        raise UpdateError("%s/%s has no published release, or it is private: a private repository "
                          "needs an access token (Settings > Updates)." % (owner, repo), 404)


def asset_name(version, product="TickAssist"):
    return "%s-%s-update.zip" % (product, version)


def _version(release):
    return str(release.get("tag_name") or "").lstrip("vV")


def _pick(release, product, token):
    """This product's update zip in a release, or None."""
    version = _version(release)
    assets = [a for a in release.get("assets") or [] if isinstance(a, dict)]
    want = asset_name(version, product).lower()
    asset = next((a for a in assets if str(a.get("name", "")).lower() == want), None)
    if asset is None:
        return None
    digest = str(asset.get("digest") or "")
    # With a token the file is fetched through the API: the one way into a
    # private repository.
    return {"version": version, "latest": version,
            "zip_url": asset.get("url") if token else asset.get("browser_download_url"),
            "sha256": digest.split(":", 1)[1].lower() if digest.startswith("sha256:") else "",
            "notes": str(release.get("body") or "")}


def _offered(release):
    return isinstance(release, dict) and not release.get("draft") and not release.get("prerelease")


def check(url, current, product="TickAssist", token=""):
    """The newest release: {"latest", "current", "newer", "zip_url", "sha256", "notes"}."""
    owner, repo = repository(url)
    release = _releases(owner, repo, "releases/latest", token)
    if not _offered(release) or not re.search(r"\d", _version(release)):
        raise UpdateError("The newest release of %s/%s has a tag (%s) that isn't a version number."
                          % (owner, repo, release.get("tag_name") if isinstance(release, dict) else None))
    version = _version(release)
    found = _pick(release, product, token)
    if not found or not found["zip_url"]:
        # Nothing to install either way when this copy is that version already.
        if not is_newer(version, current):
            return {"latest": version, "current": current, "newer": False, "zip_url": "",
                    "sha256": "", "notes": str(release.get("body") or "")[:2000]}
        raise UpdateError("Version %s is out, but its release in %s/%s has no %s for this copy to "
                          "install. Run that version's installer instead."
                          % (version, owner, repo, asset_name(version, product)))
    return {"latest": version, "current": current, "newer": is_newer(version, current),
            "zip_url": found["zip_url"], "sha256": found["sha256"], "notes": found["notes"][:2000]}


def versions(url, product="TickAssist", token=""):
    """Every published version with an update zip, newest first:
    [{"version", "zip_url", "sha256", "notes"}]."""
    owner, repo = repository(url)
    releases = _releases(owner, repo, "releases?per_page=100", token)
    out = []
    for release in releases if isinstance(releases, list) else []:
        found = _pick(release, product, token) if _offered(release) else None
        if found and found["zip_url"]:
            out.append({"version": found["version"], "zip_url": found["zip_url"],
                        "sha256": found["sha256"], "notes": found["notes"][:500]})
    if not out:
        raise UpdateError("%s/%s has no release with a %s yet." % (owner, repo, asset_name("<version>", product)))
    out.sort(key=lambda i: parse_version(i["version"]), reverse=True)
    return out
