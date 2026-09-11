"""Actual-model bookmark validation and headed long-label readability."""
import re
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser

ORIGINAL = '/Volumes/librefang/worktrees/plugin-functional-verification/.pih-agent/sessions/2026-09-10T09-54-20-971Z_01a08abd-5cab-7501-a138-1e737dec606a.jsonl'
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['session-bookmarks'], wait_until='domcontentloaded')
    try:
        result = audit.invoke('session_bookmarks', {'action': 'add', 'entryId': 'missing-' + audit.marker, 'label': 'invalid target'}, allow_writes=True)
        assert result['isError']
        snapshot = audit.page.request.get(BASE + '/api/session').json()
        assert not any(e.get('type') == 'label' for e in snapshot['entries'])
        print('invalid_target_no_label_write PASS', flush=True)
        entry = next(e['id'] for e in snapshot['entries'] if e.get('type') == 'message' and e['message']['role'] == 'user')
        label = 'Bookmark review: verify native session persistence, invalid targets, readable labels, narrow panels, and recovery tests.'
        assert len(label) == 120
        result = audit.invoke('session_bookmarks', {'action': 'add', 'entryId': entry, 'label': label}, allow_writes=True)
        assert not result['isError'] and result['details']['bookmarks'] == [{'id': entry, 'entryId': entry, 'label': label}]
        for width in [1440, 960, 760]:
            audit.page.set_viewport_size({'width': width, 'height': 960})
            audit.page.goto(BASE, wait_until='domcontentloaded')
            audit.page.get_by_role('button', name=re.compile(r'^插件，已安装')).click()
            audit.page.get_by_role('button', name='查看 Session Bookmarks 详情', exact=True).click()
            card = audit.page.locator('.plugin-panel-card').filter(has_text='Session Bookmarks')
            title = card.get_by_text(label, exact=True)
            expect(title).to_be_visible()
            title.scroll_into_view_if_needed()
            audit.page.screenshot(path=f'/tmp/pih-session-bookmarks-{width}.png')
            metrics = title.evaluate('''el => ({width:el.clientWidth,scroll:el.scrollWidth,height:el.clientHeight,scrollHeight:el.scrollHeight})''')
            violations = card.evaluate('''el => {
                const right=el.getBoundingClientRect().right, errors=[];
                for(const node of el.querySelectorAll('div,strong,code'))
                    if(node.getBoundingClientRect().right>right+1) errors.push(node.tagName);
                for(let node=el;node;node=node.parentElement)
                    if(node.scrollWidth>node.clientWidth+1) errors.push('ancestor overflow');
                return errors;
            }''')
            assert not violations, f'Bookmark layout overflows at {width}: {violations}'
            assert metrics['scroll'] <= metrics['width'] + 1 and metrics['scrollHeight'] <= metrics['height'] + 1, f'Bookmark label clipped at {width}: {metrics}'
            print('bookmark_label_readable PASS', width, flush=True)
        result = audit.invoke('session_bookmarks', {'action': 'remove', 'bookmarkId': entry}, allow_writes=True)
        assert not result['isError'] and not result['details']['bookmarks']
        audit.finish()
    finally:
        response = audit.page.request.post(BASE + '/api/session/open', data={'path': ORIGINAL})
        assert response.ok and response.json()['sessionId'] == '01a08abd-5cab-7501-a138-1e737dec606a'
        audit.page.goto(BASE, wait_until='domcontentloaded')
        audit.close()
