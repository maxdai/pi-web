"""
Pi RPC client for the pi-web server.

Wraps a `pi --session <id> --mode rpc` subprocess, speaking the JSON-line protocol
over stdin/stdout.

Protocol (per pi-web-design.md and Pi source):
- Commands sent to stdin as JSON lines: {"id": "...", "type": "prompt", ...}
- Responses from stdout: {"id": "...", "type": "response", "command": ..., "success": true, "data": ...}
- Events from stdout: {"type": "message_start", ...} etc.
- Extension UI requests from stdout: {"type": "extension_ui_request", ...}
"""

from __future__ import annotations

import json
import logging
import os
import queue
import subprocess
import threading
import time
import uuid
from typing import Any, Callable, Optional

logger = logging.getLogger("rpc_client")


class RpcClient:
    """Manages a Pi RPC subprocess and provides a command/event interface."""

    def __init__(
        self,
        session_id: str,
        cwd: str,
        *,
        port: Optional[int] = None,
        env: Optional[dict] = None,
        on_event: Optional[Callable[[dict], None]] = None,
        on_exit: Optional[Callable[[int | None], None]] = None,
        pi_cmd: str = "pi",
    ) -> None:
        self.session_id = session_id
        self.cwd = cwd
        self.on_event = on_event
        self.on_exit = on_exit
        self.pi_cmd = pi_cmd
        self._env = env

        self.proc: subprocess.Popen | None = None
        self._pending: dict[str, dict] = {}  # id -> holder dict (response stored here)
        self._pending_events: dict[str, threading.Event] = {}  # id -> event
        self._lock = threading.Lock()
        self._reader_thread: threading.Thread | None = None
        self._writer_lock = threading.Lock()
        self._stopped = threading.Event()
        self._stderr_lines: list[str] = []
        self._ready_event = threading.Event()  # set once first event is seen
        self._ready_lock = threading.Lock()
        self._ready_seen = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Start the pi RPC subprocess and begin reading stdout."""
        cmd = [self.pi_cmd, "--session", self.session_id, "--mode", "rpc"]
        env = dict(os.environ)
        if self._env:
            env.update(self._env)

        self.proc = subprocess.Popen(
            cmd,
            cwd=self.cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=0,  # unbuffered; line-buffered (1) breaks stdin writes to pi RPC
            encoding="utf-8",
            errors="replace",
        )
        self._reader_thread = threading.Thread(target=self._read_loop, daemon=True)
        self._reader_thread.start()
        self._start_stderr_reader()

    def _start_stderr_reader(self) -> None:
        """Drain stderr so the pi process never blocks. Surface to a logger."""
        def run() -> None:
            assert self.proc and self.proc.stderr
            for line in self.proc.stderr:
                line = line.rstrip()
                self._stderr_lines.append(line)
                if logger.isEnabledFor(logging.DEBUG):
                    logger.debug("pi stderr: %s", line)
        threading.Thread(target=run, daemon=True).start()

    def wait_ready(
        self,
        timeout: float = 40.0,
        interval: float = 2.0,
        post_ready_delay: float = 0.5,
    ) -> None:
        """
        Wait until the pi RPC process is ready to accept commands.

        Empirically, Pi needs several seconds after emitting its first startup
        events before it will reliably process stdin commands. So we:
          1. wait for the first event on stdout (RPC loop is running), then
          2. wait an additional ``post_ready_delay`` for startup to settle, then
          3. poll get_state until it responds successfully.

        Raises RuntimeError if the process exits or times out.
        """
        deadline = time.time() + timeout
        eyes_open = self._ready_event.wait(timeout=timeout)
        if not eyes_open:
            raise RuntimeError(
                f"Timed out waiting for Pi RPC to become ready. "
                f"Stderr: {'; '.join(self._stderr_lines[-5:])}"
            )

        # Give Pi time to finish initializing after it starts emitting events.
        time.sleep(post_ready_delay)

        # Now poll get_state until it responds.
        last_err = ""
        while time.time() < deadline:
            if self.proc is not None and self.proc.poll() is not None:
                raise RuntimeError(
                    f"Pi RPC process exited prematurely (code={self.proc.returncode}). "
                    f"Stderr: {'; '.join(self._stderr_lines[-5:])}"
                )
            try:
                self.send("get_state", timeout=max(1.0, interval))
                logger.info("Pi RPC ready (session %s)", self.session_id)
                return
            except RuntimeError as e:
                last_err = str(e)
                time.sleep(interval)
        raise RuntimeError(f"Timed out waiting for Pi RPC to be ready. {last_err}")

    def stop(self) -> None:
        """Terminate the pi subprocess."""
        if self._stopped.is_set():
            return
        self._stopped.set()
        if self.proc is None:
            return

        # Try graceful terminate, then escalate to kill
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=3)

    # ------------------------------------------------------------------
    # Sending commands
    # ------------------------------------------------------------------

    def send(self, cmd_type: str, timeout: float = 120.0, **params: Any) -> dict:
        """
        Send a command and wait for its response synchronously.

        Throws an exception if the pi process exited or the command errored.
        Returns the response dict on success.

        ``timeout`` bounds how long we wait for the command response.
        """
        cmd_id = uuid.uuid4().hex
        payload: dict[str, Any] = {"id": cmd_id, "type": cmd_type, **params}

        done = threading.Event()
        holder: dict = {}  # will hold the response; same reference stored in _pending
        with self._lock:
            # Store the holder dict directly (not a nested dict) so that
            # _handle_response's writes to holder["response"] are visible here.
            self._pending[cmd_id] = holder
            # keep event separately for correlation in _handle_response
            self._pending_events[cmd_id] = done

        self._write(payload)

        # Wait for response (bounded; agent may take a while to idle, but the
        # response to most commands is immediate once the process is ready).
        done.wait(timeout=timeout)
        with self._lock:
            self._pending.pop(cmd_id, None)
            self._pending_events.pop(cmd_id, None)

        response = holder.get("response")
        if response is None:
            raise RuntimeError(f"No response for command {cmd_type} (process may have exited)")

        if not response.get("success", False):
            raise RuntimeError(response.get("error", f"Command {cmd_type} failed"))
        return response

    def send_async(self, cmd_type: str, **params: Any) -> str:
        """
        Send a command without waiting for its response. Used for commands whose
        response is handled by the event loop (e.g. prompt, which emits events
        and an async response).

        Returns the command id so callers can correlate if needed.
        """
        cmd_id = uuid.uuid4().hex
        payload: dict[str, Any] = {"id": cmd_id, "type": cmd_type, **params}
        self._write(payload)
        return cmd_id

    def _write(self, payload: dict) -> None:
        if self.proc is None or self.proc.stdin is None or self.proc.poll() is not None:
            raise RuntimeError("Pi RPC process is not running")
        line = json.dumps(payload, ensure_ascii=False) + "\n"
        with self._writer_lock:
            self.proc.stdin.write(line)
            self.proc.stdin.flush()

    # ------------------------------------------------------------------
    # Reading stdout
    # ------------------------------------------------------------------

    def _read_loop(self) -> None:
        assert self.proc and self.proc.stdout
        for line in self.proc.stdout:
            if self._stopped.is_set():
                break
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue

            # Mark readiness once the first event (e.g. extension_ui_request/setStatus)
            # or response arrives on stdout. This signals that the Pi RPC loop has
            # taken over and is ready to process commands.
            with self._ready_lock:
                if not self._ready_seen:
                    self._ready_seen = True
                    self._ready_event.set()
                    logger.info("First stdout line received from pi (ready signal)")

            if data.get("type") == "response":
                self._handle_response(data)
            else:
                # Event or extension_ui_request -> broadcast
                if self.on_event:
                    try:
                        self.on_event(data)
                    except Exception:
                        pass

        # Process exited
        if self.on_exit:
            try:
                self.on_exit(self.proc.returncode if self.proc else None)
            except Exception:
                pass

    def _handle_response(self, data: dict) -> None:
        cmd_id = data.get("id")
        if not cmd_id:
            return
        with self._lock:
            holder = self._pending.get(cmd_id)
            done = self._pending_events.get(cmd_id)
            logger.debug("handle_response id=%s in_pending=%s", cmd_id, holder is not None)
        if holder is None:
            # Async response for a command we don't track (e.g. prompt) - still broadcast
            if self.on_event:
                try:
                    self.on_event(data)
                except Exception:
                    pass
            return
        # holder is the same dict reference returned by send(); store the response
        # so send() can read it after the event fires.
        holder["response"] = data
        if done is not None:
            done.set()


# Convenience command wrappers
class RpcCommands:
    """Thin wrappers around common RPC commands."""

    def __init__(self, client: RpcClient):
        self._c = client

    def get_state(self) -> dict:
        return self._c.send("get_state")

    def get_session_stats(self) -> dict:
        return self._c.send("get_session_stats")

    def get_messages(self) -> list:
        resp = self._c.send("get_messages")
        return resp.get("data", {}).get("messages", [])

    def get_entries(self, since: str | None = None) -> dict:
        params = {}
        if since is not None:
            params["since"] = since
        resp = self._c.send("get_entries", **params)
        return resp.get("data", {})

    def prompt(self, message: str) -> str:
        return self._c.send_async("prompt", message=message)

    def abort(self) -> None:
        self._c.send("abort")

    def get_available_models(self) -> list:
        resp = self._c.send("get_available_models")
        return resp.get("data", {}).get("models", [])

    def set_model(self, provider: str, model_id: str) -> dict:
        return self._c.send("set_model", provider=provider, modelId=model_id)

    def cycle_model(self) -> dict:
        return self._c.send("cycle_model")

    def get_available_thinking_levels(self) -> list:
        resp = self._c.send("get_available_thinking_levels")
        return resp.get("data", {}).get("levels", [])

    def set_thinking_level(self, level: str) -> None:
        self._c.send("set_thinking_level", level=level)

    def cycle_thinking_level(self) -> dict:
        return self._c.send("cycle_thinking_level")

    def get_commands(self) -> list:
        resp = self._c.send("get_commands")
        return resp.get("data", {}).get("commands", [])

    def bash(self, command: str) -> dict:
        resp = self._c.send("bash", command=command)
        return resp.get("data", {})

    def compact(self, custom_instructions: str | None = None) -> dict:
        params = {}
        if custom_instructions:
            params["customInstructions"] = custom_instructions
        resp = self._c.send("compact", **params)
        return resp.get("data", {})

    def set_session_name(self, name: str) -> None:
        self._c.send("set_session_name", name=name)

    def extension_ui_response(self, response_id: str, **data) -> None:
        """Send a response to a pending extension UI request (select/confirm/input/editor)."""
        payload = {"type": "extension_ui_response", "id": response_id, **data}
        self._c._write(payload)
