"""Real malformed HTTP target; optionally inspect the retained error without model calls."""
import argparse
import re
import socket
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import LivePluginBrowser

parser = argparse.ArgumentParser()
parser.add_argument('--retained', action='store_true')
args = parser.parse_args()
with sync_playwright() as p:
    audit = None if args.retained else LivePluginBrowser(p, ['mock-server'])
    browser = audit.browser if audit else p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless=False)
    page = audit.page if audit else browser.new_page(viewport={'width': 1440, 'height': 960})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
    started = False
    try:
        if audit:
            result = audit.invoke('mock_server_start', {'port': 0})
            assert not result['isError']
            started = True
            port = urlparse(result['details']['url']).port
            with socket.create_connection(('127.0.0.1', port), timeout=5) as connection:
                connection.sendall(b'GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
                assert connection.recv(4096).startswith(b'HTTP/1.1 500')
        else:
            page.goto('http://127.0.0.1:3144', wait_until='networkidle')
        panels = page.request.get('http://127.0.0.1:3144/api/plugin-ui').json()['items']
        state = next(item['data'] for item in panels if item['id'] == 'mock-server-panel')
        assert state['lastError'] == 'Invalid URL'
        page.get_by_role('button', name=re.compile(r'^插件，已安装')).click()
        page.get_by_role('button', name='查看 Mock Server 详情', exact=True).click()
        expect(page.get_by_role('alert').filter(has_text='Invalid URL')).to_be_visible()
        page.get_by_role('alert').filter(has_text='Invalid URL').scroll_into_view_if_needed()
        page.screenshot(path='/tmp/pih-mock-server-error.png')
        assert not errors, errors
        print('mock_server_error_visible PASS; retained=' + str(args.retained), flush=True)
    finally:
        try:
            if started:
                audit.invoke('mock_server_stop', {})
        finally:
            browser.close()
