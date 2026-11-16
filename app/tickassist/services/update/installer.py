"""Installing a version: download, verify, copy over the program files, and
put the previous version back if anything fails halfway.

The data folder, the office settings (app/owner.json) and the bundled Python
runtime are never touched, so settings, lists and macros survive. The previous
version is kept in <data>/updates/backup.

A copy only ever installs an update of its own kind: one that carries the
optional package exactly when this copy has it. Anything else would take
that package away, or add it where it doesn't belong.
"""

import hashlib
import io
import os
import shutil
import tempfile
import zipfile

from .. import owner as owner_file
from .common import UpdateError, is_newer, open_url

MAX_ZIP = 200 * 1024 * 1024
# Never overwritten or deleted by an update (paths relative to the program folder).
PROTECTED = ("data/", "runtime/", "app/owner.json", "installed.txt", "app/owner-patch.json")
# Every TickAssist update zip holds these; copies already in the field refuse
# a zip without app/server.py, so it stays the entry point.
REQUIRED = ("VERSION", "app/server.py")
# The optional package's own file (config._has_dev looks for the same one).
EXTENSION = "app/tickassist/dev/__init__.py"


def _download(zip_url, sha256, token=""):
    buf = io.BytesIO()
    # GitHub's API hands a release file over only when asked for it as a file.
    with open_url(zip_url, token, accept="application/octet-stream" if token else "") as resp:
        while True:
            chunk = resp.read(256 * 1024)
            if not chunk:
                break
            buf.write(chunk)
            if buf.tell() > MAX_ZIP:
                raise UpdateError("The update file is larger than expected - not installing it.")
    data = buf.getvalue()
    if sha256 and hashlib.sha256(data).hexdigest() != sha256:
        raise UpdateError("The downloaded update doesn't match its checksum - not installing it.")
    return data


def _payload(zf):
    """{relative path: ZipInfo} for the program files inside the zip, with any
    wrapping folder (TickAssist-4.40/...) removed."""
    names = [i for i in zf.infolist() if not i.is_dir()]
    roots = [i.filename for i in names if i.filename.split("/")[-1] == "VERSION"]
    if not roots:
        raise UpdateError("That zip isn't a TickAssist update (no VERSION file).")
    root = min(roots, key=lambda n: n.count("/"))
    prefix = root[: -len("VERSION")]
    out = {}
    for info in names:
        if not info.filename.startswith(prefix):
            continue
        rel = info.filename[len(prefix):]
        if (not rel or rel.startswith("/") or ".." in rel.split("/") or ":" in rel
                or "\\" in rel):
            raise UpdateError("The update contains an unsafe file path - not installing it.")
        out[rel] = info
    if any(r not in out for r in REQUIRED):
        raise UpdateError("That zip isn't a TickAssist update (no app/server.py).")
    return out


def _protected(rel):
    return any(rel == p or (p.endswith("/") and rel.startswith(p)) for p in PROTECTED)


def _backup(root, data_dir):
    dest = os.path.join(data_dir, "updates", "backup")
    shutil.rmtree(dest, ignore_errors=True)
    os.makedirs(dest, exist_ok=True)
    for name in ("app", "VERSION", "run.bat", "README.md"):
        src = os.path.join(root, name)
        if os.path.isdir(src):
            shutil.copytree(src, os.path.join(dest, name),
                            ignore=shutil.ignore_patterns("__pycache__", "owner.json"))
        elif os.path.isfile(src):
            shutil.copy2(src, os.path.join(dest, name))
    return dest


def _restore(root, backup):
    for dirpath, _dirs, files in os.walk(backup):
        for fn in files:
            src = os.path.join(dirpath, fn)
            rel = os.path.relpath(src, backup).replace(os.sep, "/")
            if _protected(rel):
                continue
            dst = os.path.join(root, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)


def apply(info, root, data_dir, current, allow_older=False, extension=False, token=""):
    """Download and install the update described by check(). Returns
    {"old", "new", "files"}. The running program must be restarted afterwards.
    `extension` says this copy has the optional package; `token` is the
    access token the address needs, if any."""
    if not info.get("zip_url"):
        raise UpdateError("That release has no update file for this copy to install.")
    data = _download(info["zip_url"], info.get("sha256") or "", token)
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise UpdateError("The downloaded update isn't a valid zip file.")
    with zf:
        payload = _payload(zf)
        if (EXTENSION in payload) != bool(extension):
            raise UpdateError("That update is for a different edition of TickAssist - not installing it. "
                              "Check the update address in Settings > Updates.")
        new_version = (zf.read(payload["VERSION"]).decode("utf-8-sig").strip().lstrip("vV")
                       if "VERSION" in payload else info.get("latest", ""))
        if new_version and not allow_older and not is_newer(new_version, current):
            raise UpdateError(f"Already on {current}; the download is {new_version}.")
        backup = _backup(root, data_dir)
        wanted = {r: i for r, i in payload.items() if not _protected(r)}
        written = []
        try:
            # VERSION goes last: the running program notices it changed.
            for rel in sorted(wanted, key=lambda r: (r == "VERSION", r)):
                dst = os.path.join(root, *rel.split("/"))
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dst), prefix=".upd-")
                with os.fdopen(fd, "wb") as fh:
                    fh.write(zf.read(wanted[rel]))
                os.replace(tmp, dst)
                written.append(rel)
            # Remove program files the new version no longer has.
            old_app = os.path.join(root, "app")
            for dirpath, dirs, files in os.walk(old_app):
                dirs[:] = [d for d in dirs if d != "__pycache__"]
                for fn in files:
                    rel = os.path.relpath(os.path.join(dirpath, fn), root).replace(os.sep, "/")
                    if rel not in payload and not _protected(rel) and not fn.startswith(".upd-"):
                        os.remove(os.path.join(dirpath, fn))
            if "app/owner-patch.json" in payload:
                owner_file.merge_patch(os.path.join(root, "app", "owner.json"),
                                  zf.read(payload["app/owner-patch.json"]))
        except Exception as err:            # put the old version back
            _restore(root, backup)
            if isinstance(err, PermissionError):
                raise UpdateError("The update was undone: TickAssist couldn't replace one of its own files "
                                  "(%s). Close any other TickAssist window and try again, or run the "
                                  "installer instead - it keeps your settings."
                                  % os.path.basename(getattr(err, "filename", None) or "") or "a file in use")
            raise UpdateError(f"The update failed and was undone: {err}")
    return {"old": current, "new": new_version, "files": len(written)}
