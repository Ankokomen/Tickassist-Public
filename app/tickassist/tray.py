"""The tray icon: TickAssist's control console.

TickAssist runs without a window of its own, so this is where it is seen and
steered from: an icon by the clock whose menu opens the page, opens MAX,
says how the MAX reader is doing, and restarts or quits the program.

Two halves. menu() is the menu as plain data, and Console.run() does what an
entry says - both testable anywhere. Tray is the Windows part: a hidden
window, the icon, and the message loop that shows the menu, on a thread of
its own. Standard library only (ctypes).
"""

import os
import threading

# Menu entries: (id, label, enabled). id None is a line of text, "-" a rule.
OPEN, OPEN_MAX, UPDATES, RESTART, QUIT = "open", "open-max", "updates", "restart", "quit"


def reader_line(status):
    """How reading MAX is going, in a few words."""
    state = (status or {}).get("state") or "off"
    if state == "off":
        return "Incoming calls: off"
    if state == "unsupported":
        return "Incoming calls: needs Windows"
    if state == "starting":
        return "Incoming calls: starting..."
    if state == "error":
        return "Incoming calls: the reader stopped"
    if status.get("windows") or status.get("browser") == "connected":
        return "Incoming calls: reading MAX"
    return "Incoming calls: MAX is not open"


def menu(version, status, update=None, calls_on=True):
    """The menu's entries, top to bottom. `update` is a newer version's
    number when one is known to be out."""
    items = [(OPEN, "Open TickAssist", True)]
    if calls_on:
        items.append((OPEN_MAX, "Open MAX", True))
    items += [("-", "", False),
              (None, "TickAssist %s" % version, False)]
    if calls_on:
        items.append((None, reader_line(status), False))
    items += [("-", "", False),
              (UPDATES, "Install version %s..." % update if update else "Check for updates...", True),
              (RESTART, "Restart TickAssist", True),
              (QUIT, "Quit TickAssist", True)]
    return items


class Console:
    """What the menu's entries do. Everything it needs is handed in, so it
    knows nothing of Windows."""

    def __init__(self, app, url, open_page, restart, quit_):
        self.app = app
        self.url = url
        self._open_page = open_page      # (address) -> None
        self._restart = restart          # () -> None
        self._quit = quit_               # () -> None

    def entries(self):
        calls_on = self.app.feature_on("calls")
        known = self.app.updates.known_newer()
        return menu(self.app.updates.current(), self.app.calls.status() if calls_on else None, known, calls_on)

    def tooltip(self):
        return "TickAssist %s" % self.app.updates.current()

    def run(self, entry):
        """Do a menu entry; returns a line to show the user, or ""."""
        if entry == OPEN:
            self._open_page(self.url)
        elif entry == OPEN_MAX:
            settings = self.app.settings.all()
            result = self.app.calls.open_max((settings.get("max_url") or "").strip(),
                                             settings.get("max_browser") or "auto")
            return result.get("message") or ""
        elif entry == UPDATES:
            self._open_page(self.url + "?page=settings")
        elif entry == RESTART:
            self._restart()
        elif entry == QUIT:
            self._quit()
        return ""


# ---- Windows ---------------------------------------------------------------------
WM_DESTROY, WM_CLOSE, WM_COMMAND, WM_APP = 0x0002, 0x0010, 0x0111, 0x8000
WM_LBUTTONUP, WM_RBUTTONUP, WM_CONTEXTMENU = 0x0202, 0x0205, 0x007B
WM_TRAY = WM_APP + 1
NIM_ADD, NIM_MODIFY, NIM_DELETE = 0, 1, 2
NIF_MESSAGE, NIF_ICON, NIF_TIP, NIF_INFO = 1, 2, 4, 0x10
MF_STRING, MF_GRAYED, MF_SEPARATOR = 0x0, 0x1, 0x800
TPM_RIGHTBUTTON, TPM_RETURNCMD, TPM_NONOTIFY = 0x2, 0x100, 0x80
IMAGE_ICON, LR_LOADFROMFILE, LR_DEFAULTSIZE = 1, 0x10, 0x40
IDI_APPLICATION = 32512


class Tray:
    """The icon by the clock. start() returns once it is up (or could not be:
    then .ok is False and TickAssist simply runs without one)."""

    def __init__(self, console, icon_path):
        self.console = console
        self.icon_path = icon_path
        self.ok = False
        self.hwnd = None
        self._ready = threading.Event()
        self._thread = None
        self._ids = {}

    def start(self, wait=5.0):
        if os.name != "nt":
            return False
        self._thread = threading.Thread(target=self._run, daemon=True, name="tray")
        self._thread.start()
        self._ready.wait(wait)
        return self.ok

    def stop(self):
        """Take the icon away (it would otherwise linger until pointed at)."""
        if self.hwnd:
            self._user32.PostMessageW(self.hwnd, WM_CLOSE, 0, 0)
            if self._thread and self._thread is not threading.current_thread():
                self._thread.join(3)

    def notify(self, title, text):
        """A short balloon from the icon."""
        if not self.ok or not text:
            return
        nid = self._nid(NIF_INFO)
        nid.szInfoTitle = title[:63]
        nid.szInfo = text[:255]
        self._shell32.Shell_NotifyIconW(NIM_MODIFY, self._ctypes.byref(nid))

    # ---- the thread ---------------------------------------------------------------
    def _run(self):
        try:
            self._create()
        except Exception as err:          # noqa: BLE001 - no tray is not worth stopping for
            print("  The tray icon could not be shown: %s" % err)
            self._ready.set()
            return
        self.ok = True
        self._ready.set()
        ctypes, wintypes, user32 = self._ctypes, self._wintypes, self._user32
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))
        self.ok = False

    def _create(self):
        import ctypes
        from ctypes import wintypes
        self._ctypes, self._wintypes = ctypes, wintypes
        user32 = self._user32 = ctypes.WinDLL("user32", use_last_error=True)
        shell32 = self._shell32 = ctypes.WinDLL("shell32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        LRESULT = ctypes.c_ssize_t
        WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)

        class WNDCLASSW(ctypes.Structure):
            _fields_ = [("style", wintypes.UINT), ("lpfnWndProc", WNDPROC), ("cbClsExtra", ctypes.c_int),
                        ("cbWndExtra", ctypes.c_int), ("hInstance", wintypes.HINSTANCE), ("hIcon", wintypes.HICON),
                        ("hCursor", wintypes.HANDLE), ("hbrBackground", wintypes.HBRUSH),
                        ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR)]

        class NOTIFYICONDATAW(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.DWORD), ("hWnd", wintypes.HWND), ("uID", wintypes.UINT),
                        ("uFlags", wintypes.UINT), ("uCallbackMessage", wintypes.UINT), ("hIcon", wintypes.HICON),
                        ("szTip", wintypes.WCHAR * 128), ("dwState", wintypes.DWORD), ("dwStateMask", wintypes.DWORD),
                        ("szInfo", wintypes.WCHAR * 256), ("uVersion", wintypes.UINT),
                        ("szInfoTitle", wintypes.WCHAR * 64), ("dwInfoFlags", wintypes.DWORD),
                        ("guidItem", ctypes.c_byte * 16), ("hBalloonIcon", wintypes.HICON)]

        self._NID = NOTIFYICONDATAW
        user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        user32.DefWindowProcW.restype = LRESULT
        user32.CreateWindowExW.restype = wintypes.HWND
        user32.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
                                           ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.HWND,
                                           wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
        user32.LoadImageW.restype = wintypes.HANDLE
        user32.LoadImageW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT, ctypes.c_int, ctypes.c_int,
                                      wintypes.UINT]
        user32.LoadIconW.restype = wintypes.HICON
        user32.LoadIconW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR]
        user32.CreatePopupMenu.restype = wintypes.HMENU
        user32.AppendMenuW.argtypes = [wintypes.HMENU, wintypes.UINT, ctypes.c_size_t, wintypes.LPCWSTR]
        user32.TrackPopupMenu.argtypes = [wintypes.HMENU, wintypes.UINT, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                          wintypes.HWND, wintypes.LPVOID]
        user32.DestroyMenu.argtypes = [wintypes.HMENU]
        user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        user32.DestroyWindow.argtypes = [wintypes.HWND]
        user32.SetForegroundWindow.argtypes = [wintypes.HWND]
        shell32.Shell_NotifyIconW.argtypes = [wintypes.DWORD, ctypes.POINTER(NOTIFYICONDATAW)]
        kernel32.GetModuleHandleW.restype = wintypes.HMODULE
        kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]

        self._taskbar_created = user32.RegisterWindowMessageW("TaskbarCreated")
        self._proc = WNDPROC(self._wndproc)                # kept: Windows calls it for as long as the window lives
        instance = kernel32.GetModuleHandleW(None)
        cls = WNDCLASSW()
        cls.lpfnWndProc = self._proc
        cls.hInstance = instance
        cls.lpszClassName = "TickAssistTray%d" % os.getpid()
        if not user32.RegisterClassW(ctypes.byref(cls)):
            raise OSError("RegisterClass failed (%d)" % ctypes.get_last_error())
        # A window nobody sees: it is only there to be sent the icon's messages.
        self.hwnd = user32.CreateWindowExW(0, cls.lpszClassName, "TickAssist", 0, 0, 0, 0, 0, None, None, instance, None)
        if not self.hwnd:
            raise OSError("CreateWindow failed (%d)" % ctypes.get_last_error())
        self._icon = user32.LoadImageW(None, self.icon_path, IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE) \
            or user32.LoadIconW(None, ctypes.cast(IDI_APPLICATION, wintypes.LPCWSTR))
        if not self._add():
            user32.DestroyWindow(self.hwnd)
            self.hwnd = None
            raise OSError("Windows did not accept the icon")
        self._build_ids()

    def _nid(self, flags):
        nid = self._NID()
        nid.cbSize = self._ctypes.sizeof(self._NID)
        nid.hWnd = self.hwnd
        nid.uID = 1
        nid.uFlags = flags
        return nid

    def _add(self):
        nid = self._nid(NIF_MESSAGE | NIF_ICON | NIF_TIP)
        nid.uCallbackMessage = WM_TRAY
        nid.hIcon = self._icon
        nid.szTip = self.console.tooltip()[:127]
        return bool(self._shell32.Shell_NotifyIconW(NIM_ADD, self._ctypes.byref(nid)))

    def _wndproc(self, hwnd, message, wparam, lparam):
        user32 = self._user32
        try:
            if message == WM_TRAY:
                event = lparam & 0xFFFF
                if event == WM_LBUTTONUP:
                    self._do(OPEN)
                elif event in (WM_RBUTTONUP, WM_CONTEXTMENU):
                    self._show_menu()
                return 0
            if message == WM_COMMAND:                      # an entry, chosen (or sent by a test)
                self._do(self._ids.get(wparam & 0xFFFF))
                return 0
            if message == self._taskbar_created:           # Explorer restarted: the icon went with it
                self._add()
                return 0
            if message == WM_CLOSE:
                user32.DestroyWindow(hwnd)
                return 0
            if message == WM_DESTROY:
                self._shell32.Shell_NotifyIconW(NIM_DELETE, self._ctypes.byref(self._nid(0)))
                user32.PostQuitMessage(0)
                return 0
        except Exception as err:          # noqa: BLE001 - an exception must never reach Windows
            print("  Tray: %s" % err)
            return 0
        return user32.DefWindowProcW(hwnd, message, wparam, lparam)

    def _build_ids(self):
        """{command number: entry} for the menu as it is now."""
        entries = self.console.entries()
        self._ids = {100 + i: e[0] for i, e in enumerate(entries) if e[0] not in (None, "-")}
        return entries

    def _show_menu(self):
        ctypes, wintypes, user32 = self._ctypes, self._wintypes, self._user32
        entries = self._build_ids()
        popup = user32.CreatePopupMenu()
        for i, (entry, label, enabled) in enumerate(entries):
            if entry == "-":
                user32.AppendMenuW(popup, MF_SEPARATOR, 0, None)
            else:
                user32.AppendMenuW(popup, MF_STRING | (0 if enabled and entry else MF_GRAYED), 100 + i, label)
        point = wintypes.POINT()
        user32.GetCursorPos(ctypes.byref(point))
        user32.SetForegroundWindow(self.hwnd)              # or the menu stays up when clicked away from
        chosen = user32.TrackPopupMenu(popup, TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY,
                                       point.x, point.y, 0, self.hwnd, None)
        user32.DestroyMenu(popup)
        if chosen:
            self._do(self._ids.get(chosen))

    def _do(self, entry):
        if not entry:
            return
        # Off this thread: an entry may take a while (starting a browser) or
        # end the program, and the icon must keep answering meanwhile.
        def work():
            try:
                said = self.console.run(entry)
                if said:
                    self.notify("TickAssist", said)
            except Exception as err:      # noqa: BLE001
                self.notify("TickAssist", str(err))
        threading.Thread(target=work, daemon=True, name="tray-action").start()
