"""A delayed plugin-panel response must not hold session/runtime status hostage."""
from playwright.sync_api import sync_playwright, expect
import re
from live_plugin_browser import BASE, LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, [], new_session=False, wait_until='domcontentloaded')
    held = []
    def hold(route):
        held.append(route)
        audit.page.evaluate('() => { window.__slowPanelHeld = true; }')
    try:
        page = audit.page
        expect(page.locator('button.session-row.active')).to_be_visible()
        current = page.request.get(BASE + '/api/session').json()
        if not current['messages']:
            # The authoritative active row can render before the session list.
            # Wait for a populated row instead of inspecting an unfinished list.
            chosen = page.locator('button.session-row:not(.active)').filter(
                has=page.locator('small', has_text=re.compile(r'^[1-9]\d* 条消息'))
            ).first
            expect(chosen).to_be_visible()
            with page.expect_response(lambda r: r.url.endswith('/api/session/open')) as opened:
                chosen.click()
            assert opened.value.ok
            current = opened.value.json()
        assert current['messages']
        expect(page.locator('.runtime-cells b').nth(1)).to_have_text(str(len(current['messages'])))
        page.route('**/api/plugin-ui', hold)
        audit.new_session()
        page.wait_for_function('() => window.__slowPanelHeld === true', timeout=15000)
        session = page.request.get(BASE + '/api/session').json()
        status = page.request.get(BASE + '/api/status').json()
        assert not session['messages'] and status['status'] == 'ready'
        expect(page.locator('.runtime-cells b').nth(1)).to_have_text('0')
        expect(page.locator('button.session-row.active small')).to_have_text('0 条消息')
        page.screenshot(path='/tmp/pih-session-status-slow-panel.png')
        audit.finish()
        print('session_status_independent_of_plugin_panel PASS', flush=True)
    finally:
        while held:
            held.pop(0).continue_()
        audit.page.unroute('**/api/plugin-ui', hold)
        audit.close()
