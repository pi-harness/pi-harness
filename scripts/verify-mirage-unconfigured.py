"""Actual default-profile Mirage prerequisite checks, without a virtual command."""
from pathlib import Path
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

ROOT = Path(__file__).resolve().parent.parent
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['mirage-bridge'], new_session=False, wait_until='domcontentloaded')
    original = audit.page.request.get(BASE + '/api/session').json()
    assert original.get('sessionFile') and Path(original['sessionFile']).is_file()
    try:
        assert audit.page.request.post(BASE + '/api/session/new', data={'cwd': str(ROOT)}).ok
        audit.page.goto(BASE, wait_until='domcontentloaded')
        result = audit.invoke('mirage_doctor', {})
        assert not result['isError']
        state = result['details']
        assert state['available'] is False and state['workspaceId'] is None
        assert 'ENOENT' in state['lastError']
        assert state['lastError'] in result['content'][0]['text']
        audit.panel('Mirage Bridge', [state['lastError']])
        refusal = audit.invoke('mirage_execute', {'command': 'printf SYNTHETIC_MIRAGE_AUDIT'})
        assert refusal['isError']
        assert 'workspaceId is not configured' in refusal['content'][0]['text']
        panel = next(x['data'] for x in audit.page.request.get(BASE + '/api/plugin-ui').json()['items'] if x['id'] == 'mirage-bridge-panel')
        assert panel['lastRun'] is None and panel['available'] is False
        audit.finish()
        print('missing_executable_and_unconfigured_workspace_refusal PASS; virtual_execution NOT_VERIFIED', flush=True)
    finally:
        try:
            restored = audit.page.request.post(BASE + '/api/session/open', data={'path': original['sessionFile']})
            assert restored.ok, f'Session restore HTTP {restored.status}'
            audit.page.goto(BASE, wait_until='domcontentloaded')
            assert audit.page.request.get(BASE + '/api/session').json()['sessionId'] == original['sessionId']
            print('original_session_restored PASS', flush=True)
        finally:
            audit.close()
