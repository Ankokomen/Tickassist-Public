"""Just enough of a WebSocket client to talk to a browser's debugging port
(text frames, pings, fragmentation). Standard library only."""

import base64
import os
import re
import socket
import struct


class WsError(Exception):
    pass


class WebSocket:
    def __init__(self, url, timeout=4.0):
        m = re.match(r"^ws://([^/:]+):(\d+)(/.*)$", url)
        if not m:
            raise WsError("unsupported address")
        host, port, path = m.group(1), int(m.group(2)), m.group(3)
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(("GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\n"
                           "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
                           "Sec-WebSocket-Version: 13\r\n\r\n" % (path, host, port, key)).encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WsError("closed during handshake")
            buf += chunk
            if len(buf) > 65536:
                raise WsError("bad handshake")
        head, _, rest = buf.partition(b"\r\n\r\n")
        if b" 101 " not in head.split(b"\r\n")[0] + b" ":
            raise WsError(head.split(b"\r\n")[0].decode("latin1", "replace"))
        self._buf = rest

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass

    def send(self, text):
        data = text.encode("utf-8")
        n = len(data)
        head = bytearray([0x81])
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head.append(0x80 | 126)
            head += struct.pack(">H", n)
        else:
            head.append(0x80 | 127)
            head += struct.pack(">Q", n)
        mask = os.urandom(4)
        head += mask
        self.sock.sendall(bytes(head) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _read(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise WsError("connection closed")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def recv(self):
        """The next complete text message."""
        parts = []
        while True:
            b1, b2 = self._read(2)
            op, fin = b1 & 0x0F, bool(b1 & 0x80)
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            if n > 64 * 1024 * 1024:
                raise WsError("message too large")
            payload = self._read(n)         # servers do not mask
            if op == 0x8:
                raise WsError("closed by browser")
            if op == 0x9:                   # ping -> pong (masked, as clients must)
                mask = os.urandom(4)
                self.sock.sendall(bytes([0x8A, 0x80 | len(payload)]) + mask +
                                  bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
                continue
            if op in (0x1, 0x0, 0x2):
                parts.append(payload)
                if fin:
                    return b"".join(parts).decode("utf-8", "replace")
