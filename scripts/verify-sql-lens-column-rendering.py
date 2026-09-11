"""Headed Unicode SQL result rendering with controlled panel data, no model."""
import json
import re
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['sql-lens'], new_session=False, wait_until='domcontentloaded')
    try:
        page = audit.page
        response = page.request.get(BASE + '/api/plugin-ui')
        assert response.ok
        snapshot = response.json()
        column = 'note\u200d\u202e\u2028\x7f'
        fixture = {
            'status': {'state': 'completed', 'at': '2026-09-05T01:00:00.000Z'},
            'timeoutMs': 5000,
            'latest': {
                'cwd': '/synthetic-workspace', 'database': 'data.db',
                'query': f'SELECT 1 AS "{column}"', 'columns': [column],
                'rows': [{column: 1}], 'truncated': False, 'scannedRows': 1,
                'rowInventory': {'scanned': 1, 'returned': 1, 'shown': 1, 'truncated': False, 'displayLimit': 20},
            },
            'limits': {'queryLength': 65536, 'databaseBytes': 268435456, 'rows': 100,
                       'columns': 128, 'stringLength': 16384, 'resultBytes': 1048576,
                       'blobPreviewBytes': 256, 'panelRows': 20},
        }
        next(item for item in snapshot['items'] if item['id'] == 'sql-lens-panel')['data'] = fixture
        def inject(route):
            route.fulfill(status=200, content_type='application/json', body=json.dumps(snapshot))
        page.route('**/api/plugin-ui', inject)
        page.get_by_role('button', name=re.compile(r'^插件，已安装')).click()
        page.get_by_role('button', name='查看 SQL Lens 详情', exact=True).click()
        card = page.locator('.plugin-panel-card').filter(has_text='SQL Lens')
        for width in [1440, 760]:
            page.set_viewport_size({'width': width, 'height': 960})
            expect(card.get_by_text('1 rows', exact=True)).to_be_visible()
            output = card.locator('pre')
            expect(output).to_contain_text('note\\u200d\\u202e\\u2028\\u007f')
            assert json.loads(output.inner_text()) == fixture['latest']['rows']
            expect(card.locator('code')).to_contain_text('note\\u200d\\u202e\\u2028\\u007f')
            for character in ['\u200d', '\u202e', '\u2028', '\x7f']:
                assert character not in card.inner_text()
            output.scroll_into_view_if_needed()
            assert card.evaluate('''el => {
              for(let node=el; node; node=node.parentElement)
                if(node.scrollWidth > node.clientWidth + 1) return false;
              return true;
            }'''), 'SQL panel or ancestor overflow'
            page.screenshot(path=f'/tmp/pih-sql-columns-{width}.png')
        audit.finish()
        print('sql_unicode_columns_rendering PASS (controlled panel; no model)', flush=True)
    finally:
        audit.page.unroute('**/api/plugin-ui')
        audit.close()
