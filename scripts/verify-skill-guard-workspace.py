"""Native workspace switch must use resources loaded after server startup."""
import json
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser, BASE

root = '/Volumes/librefang/worktrees/plugin-functional-verification'
target = root + '/scripts/fixtures/plugin-verification/skill-guard-workspace'
query = 'pih-guard-workspace-probe'
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['skill-guard'], new_session=False)
    try:
        changed = audit.page.request.post(BASE + '/api/session/new', data={'cwd': target})
        assert changed.ok, changed.status
        audit.page.goto(BASE, wait_until='networkidle')
        result = audit.invoke('skill_guard_scan', {'query': query})
        assert not result['isError']
        assert result['details']['total'] == 1, 'Newly loaded skill was missing from current workspace scan'
        assert result['details']['reports'][0]['name'] == query
        assert json.loads(result['content'][0]['text']) == result['details']
        audit.panel('Skill Guard', [query])
        audit.finish()
        print('native_workspace_new_loader_scan PASS', flush=True)
    finally:
        restored = audit.page.request.post(BASE + '/api/session/new', data={'cwd': root})
        assert restored.ok, restored.status
        audit.close()
