"""Real TCP reset tests for audit reads; no model or application writes."""
import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch
from playwright.sync_api import Error as PlaywrightError, sync_playwright
import live_plugin_browser

@contextmanager
def server(resets, status=200):
    calls = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            calls.append(self.path)
            if len(calls) <= resets:
                self.connection.shutdown(2)
                self.connection.close()
                return
            body = json.dumps({'messages': ['recovered']}).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *args):
            pass
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=lambda: httpd.serve_forever(poll_interval=0.05), daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{httpd.server_port}', calls
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join()

with sync_playwright() as p:
    request = p.request.new_context()
    audit = SimpleNamespace(page=SimpleNamespace(request=request))
    try:
        with server(1) as (base, calls), patch.object(live_plugin_browser, 'BASE', base):
            assert live_plugin_browser.LivePluginBrowser.messages(audit) == ['recovered']
            assert calls == ['/api/session'] * 2
        with server(10) as (base, calls), patch.object(live_plugin_browser, 'BASE', base):
            try:
                live_plugin_browser.LivePluginBrowser.messages(audit)
                raise AssertionError('Repeated resets must fail')
            except PlaywrightError:
                pass
            assert calls == ['/api/session'] * 3, 'Retry must be finite'
        with server(0, status=503) as (base, calls), patch.object(live_plugin_browser, 'BASE', base):
            try:
                live_plugin_browser.LivePluginBrowser.messages(audit)
                raise RuntimeError('HTTP failures must remain failures')
            except AssertionError as error:
                assert '503' in str(error)
            assert calls == ['/api/session'], 'HTTP failures must not be retried'
        print('read_reset_recovery_finite_retries_http_failure PASS', flush=True)
    finally:
        request.dispose()
