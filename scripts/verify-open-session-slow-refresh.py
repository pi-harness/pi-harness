"""A successful session switch must not wait for unrelated marketplace data."""
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['theme-studio'])
    held = []
    try:
        audit.invoke('theme_status', {})
        page = audit.page
        target = page.request.get(BASE + '/api/session').json()
        title = page.locator('button.session-row.active .session-copy strong').inner_text()
        audit.new_session()
        def hold(route):
            held.append((route, route.fetch(max_retries=2)))
        page.route('**/api/marketplace?*', hold)
        with page.expect_response(lambda r: r.url.endswith('/api/session/open')) as opened:
            page.locator('button.session-row').filter(has=page.get_by_text(title, exact=True)).click()
        assert opened.value.ok
        assert opened.value.json()['sessionId'] == target['sessionId']
        expect(page.locator('button.session-row.active')).to_contain_text(audit.marker)
        assert held, 'Must actually delay a marketplace response'
        print('open_session_independent_of_marketplace PASS', flush=True)
    finally:
        while held:
            route, response = held.pop(0)
            route.fulfill(response=response)
        audit.close()
