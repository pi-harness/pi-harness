"""Recheck the existing real GenUI long-text card without new model calls."""
import re
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless=False)
    try:
        page = browser.new_page(viewport={'width': 1440, 'height': 960})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
        page.goto(BASE, wait_until='networkidle')
        response = page.request.get(BASE + '/api/plugin-ui')
        assert response.ok
        snapshot = next(item['data'] for item in response.json()['items'] if item['id'] == 'genui-panel')
        latest = snapshot['latest']
        assert latest['title'].startswith('PLUGIN_AUDIT_'), 'Only inspect a synthetic test card'
        assert latest['blocks'][0]['value'] == ''.join(f'a{i:03d}' for i in range(525))
        page.get_by_role('button', name=re.compile(r'^插件，已安装')).click()
        page.get_by_role('button', name='查看 GenUI 详情', exact=True).click()
        card = page.locator('.plugin-panel-card').filter(has_text='GenUI')
        expect(card.get_by_text(latest['blocks'][0]['value'][:2000], exact=True)).to_be_visible()
        expect(card.get_by_text('面板明细已截断', exact=True)).to_be_visible()
        card.scroll_into_view_if_needed()
        layout = card.evaluate('card => ({width:card.clientWidth, scroll:card.scrollWidth})')
        page.screenshot(path='/tmp/pih-genui-layout.png')
        print('genui_layout', layout, flush=True)
        assert layout['scroll'] <= layout['width'] + 1, 'GenUI text overflows'
        assert not errors, errors
        print('genui_layout PASS', flush=True)
    finally:
        browser.close()
