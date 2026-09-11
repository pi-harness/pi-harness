"""Focused browser regression using two existing synthetic tab-audit sessions."""
import json
import re
import argparse
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE

parser = argparse.ArgumentParser()
parser.add_argument('--source', help='Exact existing synthetic activation-request journal for a focused rerun')
args = parser.parse_args()

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless=False)
    try:
        page = browser.new_page(viewport={'width':1440, 'height':960})
        if args.source:
            entries = [json.loads(line) for line in Path(args.source).read_text().splitlines()]
            users = [entry['message'] for entry in entries if entry.get('type') == 'message' and entry.get('message', {}).get('role') == 'user']
            assert len(users) == 1 and re.search(r'PLUGIN_AUDIT_[0-9a-f]{8} Call session_tab_manage', json.dumps(users))
            assert page.request.post(BASE + '/api/session/open', data={'path':args.source}).ok
        page.goto(BASE, wait_until='networkidle')
        session = page.request.get(BASE + '/api/session').json()
        source = session['sessionFile']
        text = json.dumps(session['messages'])
        marker = re.search(r'PLUGIN_AUDIT_[0-9a-f]{8}', text).group()
        panels = page.request.get(BASE + '/api/plugin-ui').json()['items']
        tabs = next(item['data']['tabs'] for item in panels if item['id'] == 'tab-manager-panel')
        target = next(tab['sessionPath'] for tab in tabs if tab['label'] == marker + '_TARGET')
        assert source != target, 'Start on the separate synthetic activation-request session'
        page.wait_for_function('(path) => new URL(location.href).searchParams.get("session") === path', arg=source)
        switched = page.request.post(BASE + '/api/session/open', data={'path':target})
        assert switched.ok
        expect(page.locator('.turn.user').filter(has_text=marker + '_TARGET')).to_be_visible(timeout=15000)
        assert page.request.get(BASE + '/api/session').json()['sessionFile'] == target
        actual = page.evaluate('new URL(location.href).searchParams.get("session")')
        print('url_session_matches_visible_runtime', actual == target, flush=True)
        page.screenshot(path='/tmp/pih-session-url-sync.png')
        assert actual == target, 'URL still points to the previous session after the new transcript is visible'
        page.reload(wait_until='networkidle')
        expect(page.locator('.turn.user').filter(has_text=marker + '_TARGET')).to_be_visible()
        assert page.request.get(BASE + '/api/session').json()['sessionFile'] == target
        print('session_url_sync_and_reload PASS', flush=True)
    finally:
        browser.close()
