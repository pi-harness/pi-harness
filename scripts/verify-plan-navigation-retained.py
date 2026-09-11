"""Hold post-switch refresh to test reload routing using existing synthetic A/B plans."""
import re
import argparse
from urllib.parse import urlencode
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import LivePluginBrowser, BASE

parser = argparse.ArgumentParser()
parser.add_argument('--refresh-failure', action='store_true')
parser.add_argument('--initial-failure', action='store_true')
args = parser.parse_args()
fail_refresh = args.refresh_failure or args.initial_failure

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['plan-execute'], new_session=False)
    held = []
    switched = False
    try:
        current = audit.page.request.get(BASE + '/api/session').json()
        first_user = next(m for m in current['messages'] if m['role'] == 'user')
        text = first_user['content'] if isinstance(first_user['content'], str) else str(first_user['content'])
        marker = re.search(r'PLUGIN_AUDIT_[0-9a-f]{8}', text).group()
        items = audit.page.request.get(BASE + '/api/sessions').json()['items']
        source = next(x for x in items if marker in x['firstMessage'] and marker + '_SECOND' not in x['firstMessage'])
        target = next(x for x in items if marker + '_SECOND' in x['firstMessage'])
        assert source['path'] != target['path']
        assert audit.page.request.post(BASE + '/api/session/open', data={'path': source['path']}).ok
        audit.page.goto(BASE, wait_until='networkidle')
        audit.page.wait_for_function('(path) => new URL(location.href).searchParams.get("session") === path', arg=source['path'])

        def hold_refresh(route):
            if switched:
                if fail_refresh:
                    route.fulfill(status=503, json={'error': 'Synthetic current-session refresh failure'})
                else:
                    held.append(route)
                audit.page.evaluate('window.__planRefreshHeld = true')
            else:
                route.continue_()
        def complete_switch(route):
            global switched
            response = route.fetch()
            assert response.ok
            switched = True
            route.fulfill(response=response)
        audit.page.route('**/api/session', hold_refresh)
        audit.page.route('**/api/session/open', complete_switch)
        with audit.page.expect_response(lambda r: r.url.endswith('/api/session/open')) as opened:
            if args.initial_failure:
                audit.page.goto(BASE + '/?' + urlencode({'page': 'session', 'session': target['path']}), wait_until='domcontentloaded')
            else:
                audit.page.locator('button.session-row').filter(has_text=marker + '_SECOND').click()
        assert opened.value.ok
        audit.page.wait_for_function('() => window.__planRefreshHeld === true')
        if fail_refresh:
            expect(audit.page.get_by_text('部分数据刷新失败：', exact=True)).to_be_visible()
        assert audit.page.request.get(BASE + '/api/session').json()['sessionFile'] == target['path']
        actual = audit.page.evaluate('new URL(location.href).searchParams.get("session")')
        audit.page.screenshot(path='/tmp/pih-plan-navigation-pending.png')
        assert actual == target['path'], 'Completed native switch still leaves previous session in reload URL'

        # Fresh page simulates reopening the address while original refresh remains held.
        fresh = audit.browser.new_page()
        fresh.goto(audit.page.url, wait_until='networkidle')
        expect(fresh.locator('button.session-row.active')).to_contain_text(marker + '_SECOND')
        assert fresh.request.get(BASE + '/api/session').json()['sessionFile'] == target['path']
        data = next(x['data'] for x in fresh.request.get(BASE + '/api/plugin-ui').json()['items'] if x['id'] == 'plan-execute-panel')
        assert data == {'title': '会话 B 独立计划', 'completed': 0, 'total': 1,
                        'steps': [{'id': 1, 'title': '整理', 'status': 'pending'}]}
        fresh.close()
        audit.page.unroute('**/api/session', hold_refresh)
        for route in held:
            route.continue_()
        held.clear()
        audit.page.unroute('**/api/session/open', complete_switch)
        expect(audit.page.locator('button.session-row.active')).to_contain_text(marker + '_SECOND')
        audit.panel('Plan Execute', ['会话 B 独立计划', '0 / 1', '整理'])
        if fail_refresh:
            # Only these exact console errors are expected from the injected HTTP 503.
            audit.errors = [error for error in audit.errors if error != 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)']
        audit.finish()
        print('retained_plan_pending_navigation_reload PASS', flush=True)
    finally:
        for route in held:
            try:
                route.abort()
            except Exception:
                pass
        audit.close()
