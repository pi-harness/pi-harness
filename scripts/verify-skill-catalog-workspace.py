"""Catalog list/read must follow a native replacement resource loader."""
import json
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser, BASE

root = '/Volumes/librefang/worktrees/plugin-functional-verification'
query = 'pih-catalog-workspace-probe'
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['skill-catalog'], new_session=False)
    try:
        response = audit.page.request.post(BASE + '/api/session/new', data={
            'cwd': root + '/scripts/fixtures/plugin-verification/skill-guard-workspace'})
        assert response.ok, response.status
        audit.page.goto(BASE, wait_until='networkidle')
        listed = audit.invoke('skill_catalog', {'action': 'list', 'query': query})
        assert not listed['isError']
        assert listed['details']['total'] == 1
        assert listed['details']['skills'][0]['name'] == query
        assert listed['details']['skills'][0]['modelInvocationDisabled']
        assert json.loads(listed['content'][0]['text']) == listed['details']
        read = audit.invoke('skill_catalog', {'action': 'read', 'name': query})
        assert not read['isError']
        assert 'PIH_CATALOG_CURRENT_WORKSPACE_20260910' in read['content'][0]['text']
        assert 'untrusted-skill' in read['content'][0]['text']
        response = audit.page.request.get(BASE + '/api/plugin-ui')
        assert response.ok
        panel = next(item['data'] for item in response.json()['items'] if item['id'] == 'skill-catalog-panel')
        assert any(skill['name'] == query for skill in panel['skills'])
        audit.panel('Skills Catalog', [query])
        audit.finish()
        print('native_catalog_workspace_list_read_panel PASS', flush=True)
    finally:
        restored = audit.page.request.post(BASE + '/api/session/new', data={'cwd': root})
        assert restored.ok, restored.status
        audit.close()
