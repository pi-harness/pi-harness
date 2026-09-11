"""Delay one real session switch to verify rapid navigation preserves last intent."""
from playwright.sync_api import sync_playwright, expect
import time
import argparse

parser = argparse.ArgumentParser()
parser.add_argument('--create', action='store_true', help='Verify new-session creation waits for a pending switch')
args = parser.parse_args()

BASE = 'http://127.0.0.1:3144'
with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless=False,
    )
    held = []
    try:
        page = browser.new_page()
        page.goto(BASE, wait_until='networkidle')
        if not page.request.get(BASE + '/api/session').json()['messages']:
            # Select any existing non-empty session. The previous hard-coded
            # DIAGNOSTIC_ prefix made this verifier time out in production
            # when the diagnostic fixture was not present.
            candidates = page.locator('button.session-row:not(.active)')
            if candidates.count() == 0:
                raise AssertionError('No alternate session available for navigation-order verification')
            with page.expect_response(lambda r: r.url.endswith('/api/session/open')) as opened:
                candidates.first.click()
            assert opened.value.ok
            page.goto(BASE, wait_until='networkidle')
        active = page.request.get(BASE + '/api/session').json()['sessionFile']
        expect(page.locator('button.session-row.active')).to_be_visible()
        creations = []
        page.on('request', lambda request: creations.append(request)
                if request.url.endswith('/api/session/new') else None)
        def hold_first_switch(route):
            if not held:
                held.append(route)
                page.evaluate('window.__switchHeld = true')
            else:
                route.continue_()
        page.route('**/api/session/open', hold_first_switch)
        other = page.locator('button.session-row:not(.active)').first
        with page.expect_request(lambda r: r.url.endswith('/api/session/open')):
            other.click()
        page.wait_for_function('window.__switchHeld === true')
        assert len(held) == 1, 'Expected exactly one held switch'
        assert held[0].request.post_data_json['path'] != active, 'First switch must target another session'
        # The first switch cannot reach the server yet. Choose the original
        # session again while it is pending, then release the original request.
        if args.create:
            page.get_by_role('button', name='新建会话', exact=False).click()
            with page.expect_response(lambda r: r.url.endswith('/api/session/new')) as created:
                page.get_by_role('dialog').get_by_role('button').filter(has_text='plugin-functional-verification').click()
                page.evaluate("async () => { await fetch('/api/status'); }")
                assert not creations, 'Creation must wait until the earlier session switch finishes'
                held[0].continue_()
            assert created.value.ok
            active = created.value.json()['sessionFile']
        else:
            page.locator('button.session-row.active').click()
            page.evaluate("async () => { await fetch('/api/status'); }")
            with page.expect_response(lambda r: r.url.endswith('/api/session/open')) as switched:
                held[0].continue_()
            assert switched.value.ok
        deadline = time.monotonic() + 10
        while page.request.get(BASE + '/api/session').json()['sessionFile'] != active:
            if time.monotonic() >= deadline:
                raise AssertionError('A delayed older switch must not overwrite the latest selected session')
            page.wait_for_timeout(50)  # Poll the actual session identity, not a fixed readiness delay.
        current = page.request.get(BASE + '/api/session').json()['sessionFile']
        assert current == active, 'A delayed older switch must not overwrite the latest selected session'
        print('delayed_switch_last_selection_wins PASS', flush=True)
    except Exception as error:
        print('verification_failed', type(error).__name__, str(error), flush=True)
        for route in held:
            try:
                route.abort()
            except Exception:
                pass  # A previously released route cannot be aborted again.
        raise
    finally:
        browser.close()
