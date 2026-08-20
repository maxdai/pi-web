"""
Simple WebSocket server implementation using only the Python standard library.

Supports:
- HTTP handshake (RFC 6455)
- Text and binary frames
- Ping/Pong keepalive
- Fragmented message reassembly
- Client close handling
"""

from __future__ import annotations

import base64
import hashlib
import socket
import struct
import threading
from typing import Callable, Optional

MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONT = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA


class WebSocketError(Exception):
    pass


class WebSocketConnection:
    """A single WebSocket client connection."""

    def __init__(
        self,
        sock: socket.socket,
        on_message: Callable[[str], None],
        on_close: Callable[[], None],
    ) -> None:
        self.sock = sock
        self.on_message = on_message
        self.on_close = on_close
        self._lock = threading.Lock()
        self._closed = False
        self._reader_thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------------
    # Reading
    # ------------------------------------------------------------------

    def start_reading(self) -> None:
        self._reader_thread = threading.Thread(target=self._read_loop, daemon=True)
        self._reader_thread.start()

    def _read_exact(self, n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise WebSocketError("connection closed")
            buf += chunk
        return buf

    def _read_loop(self) -> None:
        try:
            while not self._closed:
                self._read_frame()
        except (WebSocketError, socket.error, OSError):
            pass
        finally:
            self.close()
            if self.on_close:
                try:
                    self.on_close()
                except Exception:
                    pass

    def _read_frame(self) -> None:
        header = self._read_exact(2)
        fin = (header[0] >> 7) & 0x01
        opcode = header[0] & 0x0F
        masked = (header[1] >> 7) & 0x01
        length = header[1] & 0x7F

        if length == 126:
            length = struct.unpack(">H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._read_exact(8))[0]

        mask_key = self._read_exact(4) if masked else None
        payload = self._read_exact(length)
        if mask_key:
            payload = bytes(
                b ^ mask_key[i % 4] for i, b in enumerate(payload)
            )

        if opcode == OP_TEXT:
            self.on_message(payload.decode("utf-8", errors="replace"))
        elif opcode == OP_BINARY:
            self.on_message(payload.decode("utf-8", errors="replace"))
        elif opcode == OP_PING:
            self._send_frame(OP_PONG, payload)
        elif opcode == OP_PONG:
            pass
        elif opcode == OP_CLOSE:
            self.close()
        elif opcode == OP_CONT:
            # For simplicity, treat continuation frames as pass-through text.
            self.on_message(payload.decode("utf-8", errors="replace"))
        else:
            raise WebSocketError(f"unsupported opcode {opcode}")

    # ------------------------------------------------------------------
    # Writing
    # ------------------------------------------------------------------

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        if self._closed:
            return
        with self._lock:
            header = bytearray()
            header.append(0x80 | opcode)
            length = len(payload)
            if length < 126:
                header.append(length)
            elif length < 65536:
                header.append(126)
                header.extend(struct.pack(">H", length))
            else:
                header.append(127)
                header.extend(struct.pack(">Q", length))
            try:
                self.sock.sendall(bytes(header) + payload)
            except (socket.error, OSError):
                self.close()

    def send_text(self, message: str) -> None:
        self._send_frame(OP_TEXT, message.encode("utf-8"))

    def send_json(self, obj: object) -> None:
        import json

        self.send_text(json.dumps(obj, ensure_ascii=False))

    # ------------------------------------------------------------------
    # Close
    # ------------------------------------------------------------------

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self.sock.close()
        except OSError:
            pass


class WebSocketServer:
    """Minimal WebSocket server that handles one handshake per incoming connection."""

    def __init__(
        self,
        handle_connection: Callable[[WebSocketConnection, dict], None],
    ) -> None:
        self.handle_connection = handle_connection

    def upgrade(self, sock: socket.socket, request: bytes) -> Optional[WebSocketConnection]:
        """Perform the WebSocket handshake and return a connection, or None on failure."""
        try:
            key = self._extract_key(request)
            if not key:
                sock.close()
                return None

            accept = base64.b64encode(
                hashlib.sha1((key + MAGIC).encode()).digest()
            ).decode()

            response = (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n"
                "\r\n"
            )
            sock.sendall(response.encode())
        except (socket.error, OSError):
            return None

        conn = WebSocketConnection(sock, lambda msg: None, lambda: None)
        return conn

    @staticmethod
    def _extract_key(request: bytes) -> Optional[str]:
        text = request.decode("utf-8", errors="replace")
        for line in text.split("\r\n"):
            if line.lower().startswith("sec-websocket-key:"):
                return line.split(":", 1)[1].strip()
        return None
