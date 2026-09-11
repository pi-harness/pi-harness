"""Real CDP against a separate owned headed Chrome with one inert test page."""
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    target_browser = p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                                      headless=False, args=['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222'])
    target = target_browser.new_page()
    target.set_content('<title>PIH CDP Fixture</title><h1>CDP read marker</h1><button id="mark" onclick="this.textContent=\'clicked marker\'">Click fixture</button>')
    audit = None
    try:
        audit = LivePluginBrowser(p, ['browser-session'], new_session=False)
        listed = audit.invoke('browser_tabs', {})
        assert not listed['isError']
        tabs = listed['details']['tabs']
        assert len(tabs) == 1 and tabs[0]['title'] == 'PIH CDP Fixture'
        identity = {'targetId': tabs[0]['targetId']}
        read = audit.invoke('browser_read', identity)
        assert not read['isError'] and 'CDP read marker' in read['content'][0]['text']
        assert 'untrusted="true"' in read['content'][0]['text']
        clicked = audit.invoke('browser_click', {**identity, 'selector': '#mark'})
        assert not clicked['isError'] and clicked['details']['clicked']
        expect(target.locator('#mark')).to_have_text('clicked marker')
        audit.panel('Browser Session', ['PIH CDP Fixture'])
        audit.finish()
        print('real_cdp_list_read_click PASS', flush=True)
    finally:
        if audit is not None:
            audit.close()
        target_browser.close()
