"""Headed long-result layout fixture, explicitly not model evidence."""
import re
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['session-search'], new_session=False, wait_until='domcontentloaded')
    try:
        snapshot = audit.page.request.get(BASE + '/api/plugin-ui').json()
        panel = next(item for item in snapshot['items'] if item['id'] == 'session-search-panel')
        panel['data'] = {'query': 'unicode-layout-fixture', 'total': 2, 'scanned': 2, 'skipped': 0,
            'truncated': False, 'nextCursor': None, 'items': [
                {'id': 'emoji', 'name': 'Owned emoji preview', 'totalHits': 1, 'hits': [{'text': '😀' * 120 + 'needle' + '😀' * 120}]},
                {'id': 'ascii', 'name': 'x' * 256, 'totalHits': 1, 'hits': [{'text': 'x' * 500}]},
            ]}
        audit.page.route('**/api/plugin-ui', lambda route: route.fulfill(json=snapshot))
        for width in [1440, 960, 760]:
            audit.page.set_viewport_size({'width': width, 'height': 960})
            audit.page.goto(BASE, wait_until='domcontentloaded')
            audit.page.get_by_role('button', name=re.compile(r'^插件，已安装')).click()
            audit.page.get_by_role('button', name='查看 Session Search 详情', exact=True).click()
            card = audit.page.locator('.plugin-panel-card').filter(has_text='Session Search')
            expect(card.get_by_text('Owned emoji preview', exact=True)).to_be_visible()
            preview = card.get_by_text('😀' * 120 + 'needle' + '😀' * 120, exact=True)
            assert preview.evaluate('''el => el.scrollHeight<=el.clientHeight+1 || ['auto','scroll'].includes(getComputedStyle(el).overflowY)'''), 'Preview text is clipped without a way to read its match'
            violations = card.evaluate('''el => {
              const box=el.getBoundingClientRect(), failures=[];
              for(const node of el.querySelectorAll('div,p')) {
                const rect=node.getBoundingClientRect();
                if(rect.right>box.right+1) failures.push({width:rect.width,cardWidth:box.width});
              }
              for(let node=el;node;node=node.parentElement)
                if(node.scrollWidth>node.clientWidth+1) failures.push({scroll:node.scrollWidth,width:node.clientWidth});
              return failures;
            }''')
            audit.page.screenshot(path=f'/tmp/pih-session-search-long-{width}.png')
            assert not violations, f'Long preview layout overflow at {width}: {violations}'
            print('long_preview_layout PASS', width, flush=True)
        audit.finish()
    finally:
        audit.close()
