"""Reopen a synthetic bridge audit session and check its populated panel."""
import argparse
import re
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE

parser = argparse.ArgumentParser()
parser.add_argument('--marker', required=True, help='Exact PLUGIN_AUDIT_xxxxxxxx marker from the bridge workflow')
args = parser.parse_args()
assert re.fullmatch(r'PLUGIN_AUDIT_[0-9a-f]{8}', args.marker), 'Only synthetic audit sessions may be reopened'

with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless=False,
    )
    try:
        page = browser.new_page(viewport={'width': 1440, 'height': 960})
        page.goto(BASE, wait_until='networkidle')
        target = page.locator('button.session-row').filter(has_text=args.marker).filter(has_text='session_bridge_import')
        expect(target).to_have_count(1)
        target.click()
        expect(page.locator('button.session-row.active').filter(has_text=args.marker).filter(has_text='session_bridge_import')).to_have_count(1)
        page.get_by_role('button', name='插件，已安装', exact=False).click()
        page.get_by_role('button', name='查看 Session Bridge 详情', exact=True).click()
        card = page.locator('.plugin-panel-card').filter(has_text='Session Bridge')
        expect(card).to_be_visible()
        expect(card.locator('p').filter(has_text='session_bridge_import').first).to_be_visible()
        card.scroll_into_view_if_needed()
        layout = card.evaluate('''card => ({width:card.clientWidth, scroll:card.scrollWidth,
          text: [...card.querySelectorAll('p, li')].map(n => ({width:n.clientWidth, scroll:n.scrollWidth}))})''')
        page.screenshot(path='/tmp/pih-session-bridge-layout.png')
        print('bridge_layout', layout, flush=True)
        assert layout['scroll'] <= layout['width'] + 1, 'Session Bridge content overflows its panel'
        assert all(n['scroll'] <= n['width'] + 1 for n in layout['text']), 'Session Bridge preview text overflows'
        print('session_bridge_layout PASS', flush=True)
    finally:
        browser.close()
