"""Headed renderer check with explicit panel fixtures; not model/runtime evidence."""
import json
import re
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['session-search'], new_session=False)
    fixture = {
        'query': 'needle-' + 'x' * 100,
        'total': 0, 'items': [], 'scanned': 200, 'skipped': 0,
        'truncated': True, 'nextCursor': '00000000-0000-4000-8000-000000000001',
    }
    response = audit.page.request.get(BASE + '/api/plugin-ui')
    assert response.ok
    panel_snapshot = response.json()
    def panel_response(route):
        body = json.loads(json.dumps(panel_snapshot))
        panel = next(item for item in body['items'] if item['id'] == 'session-search-panel')
        panel['data'] = fixture.copy()
        route.fulfill(status=200, content_type='application/json', body=json.dumps(body))
    try:
        page = audit.page
        page.route('**/api/plugin-ui', panel_response)
        page.reload(wait_until='networkidle')
        for width in [1440, 960, 760]:
            page.set_viewport_size({'width': width, 'height': 960})
            page.get_by_role('button', name=re.compile(r'^插件，已安装')).click()
            page.get_by_role('button', name='查看 Session Search 详情', exact=True).click()
            card = page.locator('.plugin-panel-card').filter(has_text='Session Search')
            expect(card.get_by_text('本页匹配 0 个会话', exact=True)).to_be_visible()
            expect(card.get_by_text(re.compile('还有未扫描的会话'))).to_be_visible()
            args = card.locator('code').filter(has_text='"cursor"')
            expect(args).to_be_visible()
            assert json.loads(args.inner_text()) == {'query': fixture['query'], 'cursor': fixture['nextCursor']}
            args.scroll_into_view_if_needed()
            ancestors = card.evaluate('''el => {
                const result = [];
                for (let node = el; node; node = node.parentElement) {
                    if (node.scrollWidth > node.clientWidth + 1)
                        result.push({tag: node.tagName, class: node.className, width: node.clientWidth, scroll: node.scrollWidth});
                }
                return result;
            }''')
            page.screenshot(path=f'/tmp/pih-session-search-page-{width}.png')
            assert not ancestors, f'Panel ancestors overflowed: {ancestors}'
            page.locator('button.session-row.active').click()
        fixture['nextCursor'] = None
        fixture['scanned'] = 5
        fixture['skipped'] = 2
        fixture['truncated'] = False
        page.reload(wait_until='networkidle')
        page.get_by_role('button', name=re.compile(r'^插件，已安装')).click()
        page.get_by_role('button', name='查看 Session Search 详情', exact=True).click()
        card = page.locator('.plugin-panel-card').filter(has_text='Session Search')
        exhausted = card.get_by_text('目录扫描已结束；跳过的文件和省略的预览不代表已完整检查。', exact=True)
        expect(exhausted).to_be_visible()
        exhausted.scroll_into_view_if_needed()
        expect(card.get_by_text(re.compile('还有未扫描的会话'))).to_have_count(0)
        page.screenshot(path='/tmp/pih-session-search-page-complete.png')
        audit.finish()
        print('session_search_panel_fixture_rendering PASS', flush=True)
    finally:
        audit.page.unroute('**/api/plugin-ui', panel_response)
        audit.close()
