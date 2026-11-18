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


def _say(message):
    """Started without a console, a failure to start would otherwise be
    silence: put it on screen."""
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, message, "TickAssist", 0x10)
    except Exception:      # noqa: BLE001
        pass


if __name__ == "__main__":
    if sys.stdout is not None or os.name != "nt":
        sys.exit(main())
    try:
        code = main()
    except SystemExit as stop:
        if stop.code not in (None, 0):
            _say("TickAssist could not start:\n\n%s" % stop.code)
        raise
    except Exception as err:      # noqa: BLE001
        import traceback
        traceback.print_exc()
        _say("TickAssist could not start:\n\n%s\n\nThe details are in tickassist.log in its data folder." % err)
        sys.exit(1)
    sys.exit(code)
