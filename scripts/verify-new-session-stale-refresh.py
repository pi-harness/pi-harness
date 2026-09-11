"""Hold real session reads across creation; old data must not reappear."""
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['theme-studio'])
    held = []
    try:
        page = audit.page
        audit.invoke('theme_status', {})
        original = page.request.get(BASE + '/api/session').json()
        assert original['messages'], 'Requires a populated current session'
        old_count = len(original['messages'])
        def hold(route):
            response = route.fetch(max_retries=2)
            held.append((route, response))
            page.evaluate('n => window.__heldSessionReads = n', len(held))
        page.route('**/api/session', hold)
        page.wait_for_function('() => window.__heldSessionReads >= 1', timeout=20000)
        assert held[0][1].json()['sessionId'] == original['sessionId']
        page.get_by_role('button', name='新建会话', exact=False).click()
        with page.expect_response(lambda r: r.url.endswith('/api/session/new')) as pending:
            page.get_by_role('dialog').get_by_role('button').filter(has_text='plugin-functional-verification').click()
        created = pending.value.json()
        assert pending.value.ok and created['sessionId'] != original['sessionId']
        expect(page.get_by_role('dialog')).not_to_be_visible()
        expect(page.locator('button.session-row.active small')).to_have_text('0 条消息')
        page.wait_for_function('() => window.__heldSessionReads >= 2', timeout=20000)
        # New refresh cannot apply while its session response remains held.
        route, response = held.pop(0)
        route.fulfill(response=response)
        # Observe the old batch's remaining body reads and React commits via
        # the visible message count. A regression is an actual old count.
        try:
            expect(page.locator('button.session-row.active small')).to_have_text(f'{old_count} 条消息', timeout=10000)
        except AssertionError:
            expect(page.locator('button.session-row.active small')).to_have_text('0 条消息')
        else:
            raise AssertionError('Old refresh restored previous session after creation')
        # Also verify recovery after the delayed new-session reads complete.
        while held:
            pending_route, pending_response = held.pop(0)
            pending_route.fulfill(response=pending_response)
        page.unroute('**/api/session', hold)
        current = page.request.get(BASE + '/api/session').json()
        assert current['sessionId'] == created['sessionId'] and not current['messages']
        expect(page.locator('button.session-row.active small')).to_have_text('0 条消息')
        audit.finish()
        print('new_session_stale_refresh PASS', flush=True)
    finally:
        for route, response in held:
            try:
                route.fulfill(response=response)
            except Exception:
                pass
        audit.close()
