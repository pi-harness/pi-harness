"""Headed installed-package startup/UI acceptance; deliberately no model request."""
import os
from pathlib import Path
import queue
import re
import signal
import subprocess
import sys
import threading
import time

from playwright.sync_api import expect, sync_playwright


def terminate_verifier(_signal, _frame):
    # The package runner bounds this process too. Let finally reap its launcher
    # if that outer deadline or the caller terminates the verification.
    raise SystemExit('Packed-browser verification interrupted')


def main():
    signal.signal(signal.SIGTERM, terminate_verifier)
    harness_root, temporary_root = map(Path, sys.argv[1:])
    entrypoint = harness_root / 'apps/web/server-dist/bin.js'
    assert entrypoint.is_file(), 'Installed web entrypoint absent'
    # Carry only OS execution essentials, never provider credentials/config from
    # the authenticated source instance or the user's agent directory.
    env = {key: os.environ[key] for key in ('PATH', 'HOME', 'TMPDIR') if key in os.environ}
    env.update({
        'PI_HARNESS_HOME': str(temporary_root / 'browser-home'),
        'PI_AGENT_DIR': str(temporary_root / 'browser-agent'),
        'PI_HARNESS_HOST': '127.0.0.1',
        'PI_HARNESS_PORT': '0',
        'PI_HARNESS_PROVIDER': 'anthropic',
        'PI_HARNESS_MODEL': 'claude-sonnet-4-5',
        'PI_HARNESS_DISABLE_UPDATE_CHECK': '1',
    })
    child = subprocess.Popen(['node', str(entrypoint)], cwd=temporary_root, env=env,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    lines = queue.Queue()
    def read_lines():
        for line in child.stdout:
            lines.put(line)
    reader = threading.Thread(target=read_lines, daemon=True)
    reader.start()
    startup_lines = []
    try:
        deadline = time.monotonic() + 60
        base = None
        while time.monotonic() < deadline:
            if child.poll() is not None:
                reader.join(timeout=2)
                while not lines.empty():
                    startup_lines.append(lines.get_nowait())
                # Isolated startup only: no provider credentials or user sessions
                # are available to this child. Keep bounded diagnostics on failure.
                print(''.join(startup_lines)[-8000:], file=sys.stderr, flush=True)
                raise AssertionError(f'Installed launcher exited before ready: {child.returncode}')
            try:
                line = lines.get(timeout=min(0.2, max(0.001, deadline - time.monotonic())))
            except queue.Empty:
                continue
            startup_lines.append(line)
            match = re.search(r'Pi Harness web console: (\S+)', line)
            if match:
                base = match.group(1).rstrip('/')
                break
        assert base, 'Installed launcher did not become ready within 60 seconds'
        with sync_playwright() as p:
            browser = p.chromium.launch(
                executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                headless=False,
            )
            try:
                page = browser.new_page(viewport={'width': 1440, 'height': 960})
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
                response = page.goto(base, wait_until='domcontentloaded')
                assert response.ok, f'Installed document HTTP {response.status}'
                expect(page.get_by_role('textbox', name='Prompt', exact=True)).to_be_visible()
                assets = page.locator('script[src]').evaluate_all('(nodes) => nodes.map(n => n.src)')
                assert assets, 'No shipped JavaScript loaded'
                assert all(url.startswith(base + '/') for url in assets), 'Unexpected external runtime script'
                for asset in assets:
                    loaded = page.request.get(asset)
                    assert loaded.ok and 'javascript' in loaded.headers.get('content-type', ''), 'Shipped JavaScript unavailable'
                styles = page.locator('link[rel="stylesheet"]').evaluate_all('(nodes) => nodes.map(n => n.href)')
                assert styles, 'No shipped stylesheet loaded'
                for style in styles:
                    assert style.startswith(base + '/'), 'Unexpected external stylesheet'
                    loaded = page.request.get(style)
                    assert loaded.ok and 'text/css' in loaded.headers.get('content-type', ''), 'Shipped stylesheet unavailable'
                plugins = page.request.get(base + '/api/plugins')
                assert plugins.ok
                items = plugins.json()['items']
                assert items and all(item['state'] == 'active' for item in items), 'Missing or inactive installed infrastructure'
                page.get_by_role('button', name=re.compile(r'^插件，已安装')).click()
                page.get_by_role('button', name='插件市场', exact=True).click()
                expect(page.get_by_role('textbox', name='搜索插件')).to_be_visible()
                assert page.request.post(base + '/api/session/new', data={'cwd': str(temporary_root)}).ok
                snapshot = page.request.get(base + '/api/session').json()
                assert snapshot['sessionId'] and not snapshot['messages']
                page.goto(base, wait_until='domcontentloaded')
                expect(page.get_by_role('textbox', name='Prompt', exact=True)).to_be_visible()
                page.reload(wait_until='domcontentloaded')
                expect(page.get_by_role('textbox', name='Prompt', exact=True)).to_be_visible()
                assert page.request.get(base + '/api/session').json()['sessionId'] == snapshot['sessionId']
                assert not errors, f'Installed browser reported {len(errors)} errors'
                print('packed_headed_startup_assets_plugin_center_session_reload PASS; model invocation NOT tested', flush=True)
            finally:
                browser.close()
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=10)
                raise AssertionError('Installed launcher failed graceful shutdown')
        reader.join(timeout=2)
        child.stdout.close()
    assert child.returncode == 143, f'Unexpected shutdown exit: {child.returncode}'
    print('packed_launcher_graceful_shutdown PASS', flush=True)


if __name__ == '__main__':
    main()
