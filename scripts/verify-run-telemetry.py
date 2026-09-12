#!/usr/bin/env python3
"""Exercise the live-run telemetry UI against a deterministic local API/SSE fixture."""

from __future__ import annotations

import json
import mimetypes
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from playwright.sync_api import Page, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "apps" / "web" / "dist"


class Fixture:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.running = True
        self.phase = "thinking"
        self.started_seconds_ago = 70
        self.activity_seconds_ago = 2
        self.status_available = True
        self.sse_available = True
        self.sse_requests = 0
        self.events: list[dict[str, Any]] = []

    def status(self) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        result: dict[str, Any] = {
            "status": "running" if self.running else "ready",
            "model": "fixture/telemetry",
            "messages": 0,
            "events": len(self.events),
            "sessionId": "telemetry-fixture",
            "cwd": str(ROOT),
            "agentDir": str(ROOT / ".pi"),
            "plugins": [],
        }
        if self.running:
            result["run"] = {
                "startedAt": (now - timedelta(seconds=self.started_seconds_ago)).isoformat(),
                "lastActivityAt": (now - timedelta(seconds=self.activity_seconds_ago)).isoformat(),
                "phase": self.phase,
            }
        return result


FIXTURE = Fixture()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def json_response(self, status: int, payload: object) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("content-length", "0"))
        payload = json.loads(self.rfile.read(length) or b"{}")
        if self.path == "/fixture/state":
            with FIXTURE.lock:
                for key in (
                    "running",
                    "phase",
                    "started_seconds_ago",
                    "activity_seconds_ago",
                    "status_available",
                    "sse_available",
                ):
                    if key in payload:
                        setattr(FIXTURE, key, payload[key])
            self.json_response(200, {"ok": True})
            return
        if self.path == "/fixture/event":
            with FIXTURE.lock:
                FIXTURE.events.append(payload)
            self.json_response(200, {"ok": True})
            return
        if self.path == "/api/abort":
            with FIXTURE.lock:
                FIXTURE.running = False
            self.json_response(200, {"aborted": True})
            return
        self.json_response(404, {"error": "Not found"})

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/events":
            self.serve_events()
            return
        if path == "/api/status":
            with FIXTURE.lock:
                available = FIXTURE.status_available
                status = FIXTURE.status()
            self.json_response(200 if available else 503, status if available else {"error": "fixture runtime unavailable"})
            return
        responses: dict[str, object] = {
            "/api/session": {"sessionId": "telemetry-fixture", "messages": [], "entries": [], "events": []},
            "/api/sessions": {"items": [], "total": 0, "page": 0, "pageSize": 30, "hasNext": False},
            "/api/files": {"items": []},
            "/api/models": {"items": []},
            "/api/providers": {"items": []},
            "/api/plugins": {"items": []},
            "/api/plugin-ui": {"items": []},
            "/api/marketplace": {"items": [], "capabilities": [], "categories": [], "total": 0, "page": 0, "pageSize": 24, "hasNext": False},
            "/api/commands": {"items": []},
            "/api/workspaces": {"items": [{"path": str(ROOT), "branch": "fixture", "current": True, "name": "pi-harness"}]},
        }
        if path in responses:
            self.json_response(200, responses[path])
            return
        self.serve_asset(path)

    def serve_events(self) -> None:
        with FIXTURE.lock:
            FIXTURE.sse_requests += 1
            if not FIXTURE.sse_available:
                # A valid event-stream response that closes immediately models a recoverable transport interruption; EventSource retries it using the advertised delay.
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("cache-control", "no-cache")
                self.send_header("connection", "close")
                self.end_headers()
                self.wfile.write(b"retry: 200\n\n")
                self.wfile.flush()
                self.close_connection = True
                return
            cursor = len(FIXTURE.events)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "keep-alive")
        self.end_headers()
        try:
            self.wfile.write(b"retry: 200\n\n")
            self.wfile.flush()
            while True:
                with FIXTURE.lock:
                    if not FIXTURE.sse_available:
                        self.close_connection = True
                        return
                    events = FIXTURE.events[cursor:]
                    cursor = len(FIXTURE.events)
                for event in events:
                    frame = f"data: {json.dumps({'type': 'event', 'event': event})}\n\n".encode()
                    self.wfile.write(frame)
                self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
                time.sleep(0.1)
        except (BrokenPipeError, ConnectionResetError):
            return

    def serve_asset(self, request_path: str) -> None:
        relative = request_path.lstrip("/") or "index.html"
        candidate = (DIST / relative).resolve()
        if DIST.resolve() not in candidate.parents and candidate != DIST.resolve():
            self.json_response(403, {"error": "Forbidden"})
            return
        if not candidate.is_file():
            candidate = DIST / "index.html"
        body = candidate.read_bytes()
        self.send_response(200)
        self.send_header("content-type", mimetypes.guess_type(candidate.name)[0] or "application/octet-stream")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, _request: object, _client_address: object) -> None:
        return


def post(page: Page, path: str, payload: dict[str, Any]) -> None:
    response = page.request.post(page.url.split("/", 3)[0] + "//" + page.url.split("/", 3)[2] + path, data=payload)
    if not response.ok:
        raise AssertionError(f"fixture update failed: {response.status} {response.text()}")


def expect_text(page: Page, text: str) -> None:
    page.get_by_text(text, exact=True).first.wait_for(state="visible", timeout=10_000)


def assert_layout(page: Page) -> None:
    metrics = page.evaluate(
        """() => ({
          viewport: document.documentElement.clientWidth,
          document: document.documentElement.scrollWidth,
          stopVisible: (() => {
            const button = document.querySelector('.run-indicator .stop-button');
            if (!button) return false;
            const rect = button.getBoundingClientRect();
            return rect.width > 0 && rect.right <= document.documentElement.clientWidth;
          })(),
        })"""
    )
    if metrics["document"] != metrics["viewport"] or not metrics["stopVisible"]:
        raise AssertionError(f"invalid telemetry layout: {metrics}")


def run() -> None:
    if not (DIST / "index.html").is_file():
        raise SystemExit("apps/web/dist is missing; run npm run build -w @pi-harness/client-web && npm run build -w @pi-harness/web")
    server = Server(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_address[1]}"
    errors: list[str] = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 900})
            context.add_init_script("localStorage.setItem('pi-harness.locale', 'en')")
            page = context.new_page()
            page.on(
                "console",
                lambda message: errors.append(f"console {message.type}: {message.text}")
                if message.type == "error" and "server responded with a status of 503" not in message.text
                else None,
            )
            page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
            page.goto(base_url, wait_until="networkidle")
            expect_text(page, "Model thinking")
            expect_text(page, "New activity 2s ago")
            assert_layout(page)

            page.reload(wait_until="networkidle")
            expect_text(page, "Model thinking")
            expect_text(page, "New activity 2s ago")

            now_ms = int(time.time() * 1000)
            post(page, "/fixture/event", {"type": "message_update", "receivedAt": now_ms, "assistantMessageEvent": {"type": "text_delta", "delta": "fixture response"}})
            expect_text(page, "Model responding")
            post(page, "/fixture/event", {"type": "tool_execution_start", "receivedAt": now_ms + 1, "toolCallId": "fixture", "toolName": "read", "args": {}})
            expect_text(page, "Tool running")

            post(page, "/fixture/state", {"phase": "thinking", "activity_seconds_ago": 40})
            page.reload(wait_until="networkidle")
            expect_text(page, "Model temporarily quiet · no new activity for 40s")
            page.screenshot(path="/tmp/pi-harness-run-telemetry-1440.png", full_page=True)

            post(page, "/fixture/state", {"sse_available": False})
            expect_text(page, "Live updates interrupted; reconnecting")
            post(page, "/fixture/state", {"status_available": False})
            expect_text(page, "Pi runtime unreachable")

            post(page, "/fixture/state", {"sse_available": True, "status_available": True, "activity_seconds_ago": 1})
            try:
                page.locator(".run-indicator.active").wait_for(state="visible", timeout=10_000)
            except Exception:
                with FIXTURE.lock:
                    requests = FIXTURE.sse_requests
                indicator = page.locator(".run-indicator")
                raise AssertionError(f"SSE did not recover after {requests} requests: {indicator.get_attribute('class')} {indicator.inner_text()}") from None
            page.get_by_text("Pi runtime unreachable", exact=True).wait_for(state="detached", timeout=10_000)
            page.set_viewport_size({"width": 760, "height": 900})
            assert_layout(page)
            page.screenshot(path="/tmp/pi-harness-run-telemetry-760.png", full_page=True)

            post(page, "/fixture/state", {"running": False})
            post(page, "/fixture/event", {"type": "agent_settled", "receivedAt": int(time.time() * 1000)})
            page.locator(".run-indicator").wait_for(state="detached", timeout=10_000)
            if errors:
                raise AssertionError("browser errors: " + " | ".join(errors))
            context.close()
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    print("PASS run telemetry: reload, phase, quiet, reconnect, offline, completion, 1440px and 760px")


if __name__ == "__main__":
    run()
