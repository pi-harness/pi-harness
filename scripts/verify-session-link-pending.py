"""Delay native deep-link restoration and ensure its URL survives while pending."""
import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlencode
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, wait_for_async_condition

parser = argparse.ArgumentParser()
parser.add_argument('--target', required=True, help='An existing synthetic activation-request journal')
parser.add_argument('--empty-list', action='store_true', help='Test a successfully loaded empty session list')
args = parser.parse_args()
entries = [json.loads(line) for line in Path(args.target).read_text().splitlines()]
users = [entry['message'] for entry in entries if entry.get('type') == 'message' and entry.get('message', {}).get('role') == 'user']
assert len(users) == 1 and re.search(r'PLUGIN_AUDIT_[0-9a-f]{8} Call session_tab_manage', json.dumps(users))

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless=False)
    held = []
    try:
        page = browser.new_page()
        current = page.request.get(BASE + '/api/session').json()['sessionFile']
        assert current != args.target, 'Start on the other synthetic audit session'
        def hold(route):
            assert route.request.post_data_json['path'] == args.target
            held.append(route)
            page.evaluate('window.__restoreHeld = true')
        page.route('**/api/session/open', hold)
        if args.empty_list:
            page.route('**/api/sessions?*', lambda route: route.fulfill(json={'items':[], 'total':0, 'page':0, 'pageSize':30, 'hasNext':False}))
        page.goto(BASE + '?' + urlencode({'session':args.target}), wait_until='domcontentloaded')
        if args.empty_list:
            page.wait_for_function('(current) => new URL(location.href).searchParams.get("session") === current', arg=current, timeout=10000)
            assert not held, 'An unavailable initial target must not be opened'
            print('empty_list_link_resolution PASS', flush=True)
            browser.close()
            raise SystemExit(0)
        page.wait_for_function('() => window.__restoreHeld === true')
        assert page.request.get(BASE + '/api/session').json()['sessionFile'] == current
        matches = page.evaluate('(target) => new URL(location.href).searchParams.get("session") === target', args.target)
        print('pending_deep_link_preserved', matches, flush=True)
        assert matches, 'Initial restoration overwrote the requested link before it completed'
        url = page.url
        route = held.pop()
        route.abort()
        page.close()
        restored = browser.new_page()
        restored.goto(url, wait_until='networkidle')
        wait_for_async_condition(restored, '''async target => {
          const response = await fetch('/api/session');
          return response.ok && (await response.json()).sessionFile === target;
        }''', arg=args.target, timeout=15000)
        expect(restored.locator('.turn.user').filter(has_text='Call session_tab_manage')).to_be_visible()
        assert restored.evaluate('new URL(location.href).searchParams.get("session")') == args.target
        print('pending_link_reopen PASS', flush=True)
    finally:
        for route in held:
            route.abort()
        browser.close()
