"""Where everything lives and which version this is.

Nothing here imports from the rest of the package, so every layer can use it.
"""

import os
from dataclasses import dataclass

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT_DIR = os.path.dirname(APP_DIR)

HOST = "localhost"
PREFERRED_PORT = 8765

# The version lives in one place: the VERSION file next to run.bat. It is read
# fresh each time, so the badge follows an edit without a restart.
FALLBACK_VERSION = "3.4"


def _has_dev(app_dir):
    """Whether this copy carries the optional dev package (tickassist/dev).
    TICKASSIST_DEV=0 runs a copy that has it as if it did not."""
    if os.environ.get("TICKASSIST_DEV", "").strip() == "0":
        return False
    return os.path.isfile(os.path.join(app_dir, "tickassist", "dev", "__init__.py"))


@dataclass(frozen=True)
class Config:
    root_dir: str
    app_dir: str
    data_dir: str
    dev: bool = False         # use the dev package; the few places that do check this

    @property
    def ui_dir(self):
        """The page: index.html and its static/ files."""
        return os.path.join(self.app_dir, "ui")

    @property
    def static_dir(self):
        return os.path.join(self.ui_dir, "static")

    @property
    def page_file(self):
        return os.path.join(self.ui_dir, "index.html")

    @property
    def version_file(self):
        return os.path.join(self.root_dir, "VERSION")

    @property
    def owner_file(self):
        return os.path.join(self.app_dir, "owner.json")

    @property
    def launcher(self):
        return os.path.join(self.root_dir, "run.bat")

    def version(self):
        try:
            with open(self.version_file, "r", encoding="utf-8") as fh:
                return fh.read().strip().lstrip("vV") or FALLBACK_VERSION
        except OSError:
            return FALLBACK_VERSION


def load(root_dir=ROOT_DIR, app_dir=APP_DIR):
    """The configuration for this process. An installed copy keeps its data
    outside the program folder (the launcher sets TICKASSIST_DATA), so an
    update or an uninstall never touches it."""
    data_dir = os.environ.get("TICKASSIST_DATA") or os.path.join(root_dir, "data")
    return Config(root_dir=root_dir, app_dir=app_dir, data_dir=data_dir, dev=_has_dev(app_dir))
