"""TickAssist entry point - the program lives in the tickassist package.

This file stays at app/server.py on purpose: run.bat and "Open MAX.bat" start
it, the uninstaller finds installs by it, and copies already in the field
refuse an update zip without it.

    runtime\\python.exe app\\server.py [--no-browser] [--no-update] [--open-max]
"""

import os
import sys

# The embeddable runtime's ._pth does not add the script's folder to sys.path.
APP_DIR = os.path.dirname(os.path.abspath(__file__))
if APP_DIR not in sys.path:
    sys.path.insert(0, APP_DIR)

from tickassist.main import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
