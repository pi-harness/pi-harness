"""Real SQL TEXT with control/format characters, or recheck its retained result."""
import argparse
import json
import re
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import LivePluginBrowser

parser = argparse.ArgumentParser()
parser.add_argument('--retained', action='store_true')
args = parser.parse_args()
with sync_playwright() as p:
    if args.retained:
        browser = p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless=False)
        page = browser.new_page(viewport={'width': 1440, 'height': 960})
        audit = None
    else:
        audit = LivePluginBrowser(p, ['sql-lens'])
        browser, page = audit.browser, audit.page
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    try:
        note = 'A\x00\x7f\u200d\u202e\u2028😀'
        if audit:
            result = audit.invoke('sql_readonly', {
                'database': 'scripts/fixtures/plugin-verification/sql-lens-audit.sqlite',
                'query': "SELECT 'A' || char(0, 127, 8205, 8238, 8232) || '😀' AS note",
            })
            assert not result['isError']
            assert result['details']['rows'] == [{'note': note}]
        else:
            page.goto('http://127.0.0.1:3144', wait_until='networkidle')
        page.get_by_role('button', name=re.compile(r'^插件，已安装')).click()
        page.get_by_role('button', name='查看 SQL Lens 详情', exact=True).click()
        expect(page.get_by_text('1 rows', exact=True)).to_be_visible()
        output = page.locator('pre').filter(has_text='"note"')
        expect(output).to_be_visible()
        text = output.inner_text()
        assert json.loads(text) == [{'note': note}]
        for character in ['\x00', '\x7f', '\u200d', '\u202e', '\u2028']:
            assert character not in text
        output.scroll_into_view_if_needed()
        page.screenshot(path='/tmp/pih-sql-lens-controls.png')
        assert not errors, errors
        print('sql_lens_controls PASS; retained=' + str(args.retained), flush=True)
    finally:
        browser.close()
