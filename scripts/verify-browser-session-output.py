"""Real CDP screenshot bytes and oversized page output, no personal tabs."""
import base64
import argparse
import io
import time
from PIL import Image
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

parser = argparse.ArgumentParser()
parser.add_argument('--retained-screenshot', action='store_true')
args = parser.parse_args()

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                                headless=False, args=['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222'])
    page = browser.new_page(viewport={'width': 800, 'height': 600})
    page.set_content('<title>PIH CDP Output</title><h1>Screenshot fixture</h1><p>Visible test content</p>')
    audit = None
    try:
        audit = LivePluginBrowser(p, ['browser-session'], new_session=False)
        # Discover the owned target directly, avoiding a repeated model list call.
        deadline = time.monotonic() + 5
        while True:
            response = page.request.get('http://127.0.0.1:9222/json/list')
            assert response.ok
            targets = [item for item in response.json() if item['type'] == 'page']
            if len(targets) == 1 and targets[0]['title'] == 'PIH CDP Output':
                break
            assert time.monotonic() < deadline, [(item['type'], item['title']) for item in targets]
            time.sleep(0.05)
        params = {'targetId': targets[0]['id']}
        screenshot = ([item for item in audit.messages() if item.get('role') == 'toolResult' and item.get('toolName') == 'browser_screenshot'][-1]
                      if args.retained_screenshot else audit.invoke('browser_screenshot', params))
        assert not screenshot['isError']
        item = screenshot['content'][0]
        assert item['type'] == 'image' and item['mimeType'] == 'image/png'
        data = base64.b64decode(item['data'], validate=True)
        decoded = Image.open(io.BytesIO(data))
        decoded.load()
        # Direct CDP and Playwright's emulated devicePixelRatio can differ.
        # Validate viewport proportions and decode pixels; inspect the image too.
        assert decoded.format == 'PNG'
        assert decoded.width >= 800 and decoded.width % 800 == 0
        assert decoded.height == 600 * (decoded.width // 800)
        decoded.save('/tmp/pih-browser-session-captured.png')
        assert screenshot['details']['screenshot']['bytes'] == len(data)
        assert 'data' not in screenshot['details']['screenshot']
        page.set_content('<title>PIH CDP Output</title><pre>' + 'a' * 131071 + '😀TAIL_NOT_RETURNED</pre>')
        read = audit.invoke('browser_read', params)
        assert not read['isError'] and read['details']['truncated']
        assert len(read['details']['text'].encode('utf8')) == 131071
        assert 'TAIL_NOT_RETURNED' not in read['content'][0]['text']
        assert 'Page text is incomplete: truncated to the 128 KiB limit.' in read['content'][0]['text'].split('\n')[0]
        assert '�' not in read['details']['text']
        audit.panel('Browser Session', ['PIH CDP Output'])
        audit.finish()
        print('real_png_decode_and_oversized_text_notice PASS', flush=True)
    finally:
        if audit is not None:
            audit.close()
        browser.close()
