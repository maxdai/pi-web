"""
pi-web server

Bridges a browser (via WebSocket) to a Pi RPC subprocess.

Run standalone:
    python3 server.py <session_id> <cwd> [--port <port>]

The pii script will eventually invoke this server after resolving the session
name to a session id + cwd.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

logging.basicConfig(level=logging.DEBUG)

from rpc_client import RpcClient, RpcCommands
from websocket import WebSocketConnection, WebSocketServer

DEFAULT_PORT = 4080
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


class Peripheral:
    """Holds the Pi RPC client and manages WebSocket clients."""

    def __init__(self, session_id: str, cwd: str):
        self.session_id = session_id
        self.cwd = cwd
        self.client = RpcClient(session_id, cwd, on_event=self._on_rpc_event, on_exit=self._on_rpc_exit)
        self.commands = RpcCommands(self.client)
        self._clients: set[WebSocketConnection] = set()
        self._clients_lock = threading.Lock()
        self._exit_error: Optional[str] = None
        self._version = self._get_pi_version()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        self.client.start()
        self.client.wait_ready()

    def stop(self) -> None:
        self.client.stop()

    # ------------------------------------------------------------------
    # WebSocket client management
    # ------------------------------------------------------------------

    def add_client(self, conn: WebSocketConnection) -> None:
        with self._clients_lock:
            self._clients.add(conn)
        # Send initial state to the new client
        self._send_initial_state(conn)

    def remove_client(self, conn: WebSocketConnection) -> None:
        with self._clients_lock:
            self._clients.discard(conn)

    def _broadcast(self, obj: object) -> None:
        message = json.dumps(obj, ensure_ascii=False)
        dead: list[WebSocketConnection] = []
        with self._clients_lock:
            for conn in list(self._clients):
                try:
                    conn.send_text(message)
                except Exception:
                    dead.append(conn)
        for conn in dead:
            self.remove_client(conn)

    # ------------------------------------------------------------------
    # RPC event -> broadcast
    # ------------------------------------------------------------------

    # Events after which footer stats should be refreshed (TUI does this too)
    _STATS_REFRESH_EVENTS = {
        "agent_settled",
        "turn_end",
        "tool_execution_end",
        "compaction_end",
        "entry_appended",
        "session_info_changed",
        "thinking_level_changed",
    }

    def _on_rpc_event(self, data: dict) -> None:
        self._broadcast(data)
        if data.get("type") in self._STATS_REFRESH_EVENTS:
            self._schedule_stats_refresh()

    def _schedule_stats_refresh(self) -> None:
        """Fetch and broadcast latest session stats in a background thread.

        This must not run in the RPC read-loop thread, because get_session_stats
        is a synchronous command that would deadlock if issued from there.
        """
        def run() -> None:
            try:
                stats = self.commands.get_session_stats().get("data", {})
                self._broadcast({"type": "stats", "data": stats})
            except Exception:
                pass
        threading.Thread(target=run, daemon=True).start()

    def _on_rpc_exit(self, code: int | None) -> None:
        logging.warning("Pi RPC process exited with code=%s stderr=%s", code, self.client._stderr_lines[-5:])
        self._exit_error = f"Pi RPC process exited (code={code})"
        self._broadcast({"type": "pi_error", "error": self._exit_error})

    # ------------------------------------------------------------------
    # Initial state for new clients
    # ------------------------------------------------------------------

    def _send_initial_state(self, conn: WebSocketConnection) -> None:
        """Send history + state to a newly connected browser client."""
        try:
            conn.send_json({"type": "state", "data": self._build_state()})
            self._send_history(conn)
        except RuntimeError as e:
            conn.send_json({"type": "error", "error": str(e)})

    def _build_state(self) -> dict:
        """Build the full session state dict (model/thinking/stats/version/...)."""
        state = self.commands.get_state()
        data = state.get("data", {})
        data["cwd"] = self._format_cwd_for_footer(self.cwd)
        data["gitBranch"] = self._get_git_branch()
        data["sessionStats"] = self.commands.get_session_stats().get("data", {})
        data["version"] = self._version
        data["commands"] = self.commands.get_commands()
        return data

    def _broadcast_state(self) -> None:
        """Broadcast the full state after mutations (model/thinking/session name)."""
        try:
            self._broadcast({"type": "state", "data": self._build_state()})
        except Exception:
            pass

    def _get_pi_version(self) -> str:
        """Get the installed pi version once."""
        try:
            import subprocess

            result = subprocess.run(
                ["pi", "--version"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0:
                return result.stdout.strip()
        except Exception:
            pass
        return ""

    def _format_cwd_for_footer(self, cwd: str) -> str:
        """Show home directory as ~ like the TUI footer."""
        home = os.path.expanduser("~")
        try:
            rel = os.path.relpath(cwd, home)
            if rel == ".":
                return "~"
            if not rel.startswith(".."):
                return f"~/{rel}"
        except Exception:
            pass
        return cwd

    def _get_git_branch(self) -> str | None:
        """Return the current git branch of the session cwd, if any."""
        try:
            import subprocess

            result = subprocess.run(
                ["git", "branch", "--show-current"],
                cwd=self.cwd,
                capture_output=True,
                text=True,
                timeout=3,
            )
            if result.returncode == 0:
                branch = result.stdout.strip()
                return branch or None
        except Exception:
            pass
        return None

    def _send_history(self, conn: WebSocketConnection) -> None:
        try:
            entries = self.commands.get_entries()
            conn.send_json({"type": "history", "data": entries})
        except RuntimeError as e:
            conn.send_json({"type": "error", "error": str(e)})

    # ------------------------------------------------------------------
    # Handle incoming WebSocket messages (browser -> Pi)
    # ------------------------------------------------------------------

    def handle_client_message(self, conn: WebSocketConnection, raw: str) -> None:
        logging.debug("WS message: %s", raw[:200])
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            conn.send_json({"type": "error", "error": "Invalid JSON"})
            return

        cmd_type = data.get("type")
        if not cmd_type:
            conn.send_json({"type": "error", "error": "Missing 'type'"})
            return

        try:
            self._dispatch_command(cmd_type, data)
        except RuntimeError as e:
            conn.send_json({"type": "error", "error": str(e)})

    def _dispatch_command(self, cmd_type: str, data: dict) -> None:
        if cmd_type == "prompt":
            message = data.get("message", "")
            if not message:
                raise RuntimeError("Missing 'message'")
            self.commands.prompt(message)
        elif cmd_type == "abort":
            self.commands.abort()
        elif cmd_type == "get_state":
            pass  # broadcast via client init; ignore
        elif cmd_type == "get_stats":
            stats = self.commands.get_session_stats().get("data", {})
            self._broadcast({"type": "stats", "data": stats})
        elif cmd_type == "bash":
            command = data.get("command", "")
            if not command:
                raise RuntimeError("Missing 'command'")
            result = self.commands.bash(command)
            self._broadcast({"type": "bash_result", "command": command, "data": result})
        elif cmd_type == "cycle_model":
            self.commands.cycle_model()
            self._broadcast_state()
        elif cmd_type == "set_model":
            provider = data.get("provider")
            model_id = data.get("modelId")
            if not provider or not model_id:
                raise RuntimeError("Missing 'provider' or 'modelId'")
            self.commands.set_model(provider, model_id)
            self._broadcast_state()
        elif cmd_type == "get_available_models":
            models = self.commands.get_available_models()
            self._broadcast({"type": "models", "data": models})
        elif cmd_type == "cycle_thinking_level":
            self.commands.cycle_thinking_level()
            self._broadcast_state()
        elif cmd_type == "set_thinking_level":
            level = data.get("level")
            if not level:
                raise RuntimeError("Missing 'level'")
            self.commands.set_thinking_level(level)
            self._broadcast_state()
        elif cmd_type == "get_available_thinking_levels":
            levels = self.commands.get_available_thinking_levels()
            self._broadcast({"type": "thinking_levels", "data": levels})
        elif cmd_type == "compact":
            custom_instructions = data.get("customInstructions")
            self.commands.compact(custom_instructions)
        elif cmd_type == "set_session_name":
            name = data.get("name", "")
            if not name:
                raise RuntimeError("Missing 'name'")
            self.commands.set_session_name(name)
            self._broadcast_state()
        elif cmd_type == "extension_ui_response":
            response_id = data.get("id")
            if not response_id:
                raise RuntimeError("Missing 'id'")
            # Pass through all remaining fields (value/confirmed/cancelled)
            extra = {k: v for k, v in data.items() if k not in ("type", "id")}
            self.commands.extension_ui_response(response_id, **extra)
        else:
            raise RuntimeError(f"Unsupported command: {cmd_type}")


class ServerContext:
    """Shared state accessible from HTTP request handlers."""

    def __init__(self, peripheral: Peripheral):
        self.peripheral = peripheral
        self.ws = WebSocketServer(self._on_ws_connection)

    def _on_ws_connection(self, conn: WebSocketConnection, request_headers: dict) -> None:
        pass


class HTTPHandler(BaseHTTPRequestHandler):
    """Serves static files and upgrades WebSocket connections."""

    context: ServerContext = None  # type: ignore

    def log_message(self, format: str, *args) -> None:
        # Quiet by default
        pass

    def finish(self) -> None:
        # For WebSocket upgrades we hand the raw socket to a WebSocketConnection
        # and must NOT let BaseHTTPRequestHandler close it.
        if getattr(self, "_ws_upgraded", False):
            return
        super().finish()

    def _send_file(self, path: Path, content_type: str) -> None:
        try:
            data = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except OSError:
            self.send_error(404)

    def do_GET(self) -> None:  # noqa: N802
        # WebSocket upgrade
        if self.headers.get("Upgrade", "").lower() == "websocket":
            self._handle_ws_upgrade()
            return

        path = self.path.split("?")[0]
        if path == "/":
            path = "/index.html"

        # Resolve static path safely
        rel = path.lstrip("/")
        file_path = (STATIC_DIR / rel).resolve()
        if not str(file_path).startswith(str(STATIC_DIR.resolve())):
            self.send_error(403)
            return

        if not file_path.exists():
            self.send_error(404)
            return

        ext = file_path.suffix.lower()
        content_type = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".ico": "image/x-icon",
        }.get(ext, "application/octet-stream")
        self._send_file(file_path, content_type)

    def _handle_ws_upgrade(self) -> None:
        ctx = self.server.ws_context
        key = self.headers.get("Sec-WebSocket-Key")

        import base64
        import hashlib

        accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
        ).decode()

        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()

        # Take over the socket. We detach the underlying fd so that when the
        # HTTP handler/server finishes it cannot close the live WebSocket.
        fd = self.connection.detach()
        sock = socket.socket(fileno=fd)
        self._ws_upgraded = True
        self.close_connection = True

        peripheral = ctx.peripheral

        def on_message(msg: str) -> None:
            peripheral.handle_client_message(conn, msg)

        def on_close() -> None:
            peripheral.remove_client(conn)

        conn = WebSocketConnection(sock, on_message, on_close)
        ctx.clients.append(conn)
        peripheral.add_client(conn)
        conn.start_reading()


class PiWebHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, addr: tuple, handler_cls, peripheral: Peripheral):
        super().__init__(addr, handler_cls)
        self.ws_context = ServerContext(peripheral)
        self.ws_context.clients = []
        handler_cls.context = self.ws_context


def main() -> None:
    parser = argparse.ArgumentParser(description="pi-web server")
    parser.add_argument("session_id", help="Pi session id")
    parser.add_argument("cwd", help="Session working directory")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Port to bind (default: 4080)")
    args = parser.parse_args()

    if not (1 <= args.port <= 65535):
        print(f"Invalid port: {args.port}", file=os.sys.stderr)
        os.sys.exit(1)

    if not os.path.isdir(args.cwd):
        print(f"Working directory not found: {args.cwd}", file=os.sys.stderr)
        os.sys.exit(1)

    peripheral = Peripheral(args.session_id, args.cwd)

    try:
        httpd = PiWebHTTPServer(("127.0.0.1", args.port), HTTPHandler, peripheral)
    except OSError as e:
        print(f"Failed to bind 127.0.0.1:{args.port}: {e}", file=os.sys.stderr)
        os.sys.exit(1)

    peripheral.start()
    print(f"server at http://127.0.0.1:{args.port}/", flush=True)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        peripheral.stop()
        httpd.server_close()


if __name__ == "__main__":
    main()
