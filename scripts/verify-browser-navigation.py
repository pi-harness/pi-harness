"""Actual public navigation and private-target refusal in isolated Chrome."""
import time
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                                headless=False, args=['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222'])
    target = browser.new_page()
    target.set_content('<title>PIH Navigation Fixture</title><p>Initial page</p>')
    audit = None
    try:
        deadline = time.monotonic() + 5
        while True:
            targets = [item for item in target.request.get('http://127.0.0.1:9222/json/list').json() if item['type'] == 'page']
            if len(targets) == 1 and targets[0]['title'] == 'PIH Navigation Fixture':
                break
            assert time.monotonic() < deadline
            time.sleep(0.05)
        audit = LivePluginBrowser(p, ['browser-session'], new_session=False)
        identity = {'targetId': targets[0]['id']}
        result = audit.invoke('browser_navigate', {**identity, 'url': 'https://example.com/'})
        assert not result['isError']
        expect(target).to_have_url('https://example.com/')
        expect(target.get_by_role('heading', name='Example Domain')).to_be_visible()
        assert result['details']['url'] == 'https://example.com/'
        audit.panel('Browser Session', ['Example Domain'])
        refused = audit.invoke('browser_navigate', {**identity, 'url': 'http://127.0.0.1:3144/'})
        assert refused['isError']
        expect(target).to_have_url('https://example.com/')
        audit.finish()
        print('public_navigation_and_private_refusal PASS', flush=True)
    finally:
        if audit is not None:
            audit.close()
        browser.close()
