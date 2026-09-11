"""Actual unconfirmed read-only cat receives EOF, with a visible empty result."""
from pathlib import Path
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

ROOT = Path(__file__).resolve().parent.parent
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['auto-mode'], new_session=False, wait_until='domcontentloaded')
    original = audit.page.request.get(BASE + '/api/session').json()
    assert original.get('sessionFile') and Path(original['sessionFile']).is_file()
    try:
        assert audit.page.request.post(BASE + '/api/session/new', data={'cwd': str(ROOT)}).ok
        audit.page.goto(BASE, wait_until='domcontentloaded')
        result = audit.invoke('auto_mode_exec', {'command': ['cat']})
        assert not result['isError']
        details = result['details']
        assert details['command'] == ['cat'] and details['exitCode'] == 0
        assert details['stdout'] == '' and details['stderr'] == ''
        assert details['allowed'] is True and details['confirmed'] is False
        assert details['durationMs'] < 30000
        panel = next(x['data'] for x in audit.page.request.get(BASE + '/api/plugin-ui').json()['items'] if x['id'] == 'auto-mode-panel')
        assert panel['last'] == details and panel['blocked'] == 0
        audit.panel('Auto Mode', ['exit 0', '无输出'])
        audit.finish()
        print('real_model_unconfirmed_cat_eof_empty_panel PASS', {'commandDurationMs': details['durationMs']}, flush=True)
    finally:
        try:
            restored = audit.page.request.post(BASE + '/api/session/open', data={'path': original['sessionFile']})
            assert restored.ok, f'Session restore HTTP {restored.status}'
            audit.page.goto(BASE, wait_until='domcontentloaded')
            assert audit.page.request.get(BASE + '/api/session').json()['sessionId'] == original['sessionId']
            print('original_session_restored PASS', flush=True)
        finally:
            audit.close()
