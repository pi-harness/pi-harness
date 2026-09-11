"""Session theme and status must refresh independently of marketplace data."""
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['theme-studio'])
    held = []
    try:
        page = audit.page
        result = audit.invoke('theme_set', {'theme': 'midnight'}, allow_writes=True)
        assert not result['isError']
        expect(page.locator('.app-frame')).to_have_attribute('data-theme', 'midnight')
        def hold(route):
            held.append(route)
            page.evaluate('() => { window.__themeMarketHeld = true; }')
        page.route('**/api/marketplace?*', hold)
        audit.new_session()
        panels = page.request.get(BASE + '/api/plugin-ui').json()['items']
        theme = next(panel['data'] for panel in panels if panel['id'] == 'theme-studio-panel')
        session = page.request.get(BASE + '/api/session').json()
        assert theme['sessionId'] == session['sessionId'] and not session['messages']
        assert theme['theme'] == 'light'
        page.wait_for_function('() => window.__themeMarketHeld === true', timeout=15000)
        expect(page.locator('.app-frame')).to_have_attribute('data-theme', theme['theme'])
        expect(page.locator('.runtime-cells b').nth(1)).to_have_text('0')
        expect(page.locator('.streaming-turn')).to_have_count(0)
        audit.finish()
        print('session_theme_status_independent_of_marketplace PASS', flush=True)
    finally:
        while held:
            held.pop(0).continue_()
        audit.page.unroute('**/api/marketplace?*', hold)
        audit.close()
