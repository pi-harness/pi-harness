"""Fetch a real public page, then reject private and non-HTTP targets."""
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['browser-fetch'])
    try:
        result = audit.invoke('browser_fetch', {'url': 'https://example.com/'})
        assert not result['isError']
        details = result['details']
        assert details['status'] == 200 and details['finalUrl'] == 'https://example.com/'
        assert 'Example Domain' in details['text']
        assert details['bytes'] > 0 and details['truncated'] is False
        assert 'Example Domain' in result['content'][0]['text']
        audit.panel('Browser Fetch', ['HTTP 200', 'private:blocked', 'scripts:disabled'])
        for url, message in [
            ('http://127.0.0.1:3144/', 'private or local network address'),
            ('file:///pih-synthetic-never-read', 'only supports http and https'),
        ]:
            rejected = audit.invoke('browser_fetch', {'url': url})
            assert rejected['isError'] and message in str(rejected['content'])
            audit.panel('Browser Fetch', ['HTTP 200', 'https://example.com/'])
        audit.finish()
        print('browser_fetch_public_and_rejections PASS', flush=True)
    finally:
        audit.close()
