"""Copy the current test session while marketplace refresh is delayed."""
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser
import argparse

parser = argparse.ArgumentParser()
parser.add_argument('--sidebar', action='store_true')
parser.add_argument('--current-row', action='store_true', help='Use the pinned current row while viewing another history page')
args = parser.parse_args()

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['theme-studio'])
    held = []
    try:
        page = audit.page
        audit.invoke('theme_status', {})
        original = page.request.get(BASE + '/api/session').json()
        if args.current_row:
            page.get_by_role('button', name='下一页', exact=True).click()
            expect(page.locator('.current-session-row')).to_be_visible()
        def hold(route):
            held.append(route)
            page.evaluate('() => { window.__forkMarketHeld = true; }')
        page.route('**/api/marketplace?*', hold)
        if args.current_row:
            row = page.locator('.current-session-row')
            row.hover()
            row.get_by_role('button', name='当前会话操作', exact=True).click()
        elif args.sidebar:
            row = page.locator('.session-row-wrap').filter(has=page.locator('button.session-row.active'))
            row.hover()
            row.locator('.session-row-more').click()
        else:
            page.get_by_role('button', name='会话操作', exact=True).click()
        with page.expect_response(lambda r: r.url.endswith('/api/session/open')) as opened:
            page.get_by_role('menuitem').filter(has=page.get_by_text('复制会话', exact=True)).click()
        assert opened.value.ok
        copy = opened.value.json()
        assert copy['sessionId'] != original['sessionId']
        if copy['messages'] != original['messages']:
            print('fork_message_counts', len(original['messages']), len(copy['messages']), flush=True)
            for index, (before, after) in enumerate(zip(original['messages'], copy['messages'])):
                if before != after:
                    print('fork_changed_fields', index, [key for key in set(before) | set(after)
                          if before.get(key) != after.get(key)], flush=True)
                    print('fork_key_presence', sorted(set(before) - set(after)), sorted(set(after) - set(before)), flush=True)
        def comparable(message):
            value = dict(message)
            if value.get('role') == 'toolResult' and value.get('usage') is None:
                value.pop('usage', None)
            return value
        assert list(map(comparable, copy['messages'])) == list(map(comparable, original['messages']))
        # The new copy is not yet in the held list refresh; its fallback label
        # must identify the copy rather than the old session's cached title.
        expect(page.locator('button.session-row.active strong')).to_have_text(copy['sessionId'][:12])
        page.wait_for_function('() => window.__forkMarketHeld === true', timeout=15000)
        print('fork_session_independent_of_marketplace PASS', flush=True)
    finally:
        while held:
            held.pop(0).continue_()
        audit.page.unroute('**/api/marketplace?*', hold)
        audit.close()
