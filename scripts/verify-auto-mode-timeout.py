"""Real model/default timeout of an inert process; preserve stdout and diagnostics."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser

ROOT = Path(__file__).resolve().parent.parent
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['auto-mode'], new_session=False, wait_until='domcontentloaded')
    original = audit.page.request.get(BASE + '/api/session').json()
    assert original.get('sessionFile') and Path(original['sessionFile']).is_file()
    try:
        assert audit.page.request.post(BASE + '/api/session/new', data={'cwd': str(ROOT)}).ok
        audit.page.goto(BASE, wait_until='domcontentloaded')
        params = {'command': ['node', '-e', 'console.log("AUTO_TIMEOUT_START");process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);setTimeout(()=>process.exit(9),45000)'], 'confirm': True}
        result = audit.invoke('auto_mode_exec', params)
        assert not result['isError']  # A completed tool receipt describes the failed command.
        details = result['details']
        assert details['exitCode'] == 1 and details['confirmed'] is True
        assert details['stdout'] == 'AUTO_TIMEOUT_START\n'
        assert 'timed out after 30000 ms' in details['stderr']
        assert 'timed out after 30000 ms' in result['content'][0]['text']
        assert details['durationMs'] >= 30000
        panel = next(x['data'] for x in audit.page.request.get(BASE + '/api/plugin-ui').json()['items'] if x['id'] == 'auto-mode-panel')
        assert panel['last'] == details
        audit.panel('Auto Mode', ['exit 1'])
        audit.page.get_by_role('button', name='插件，已安装', exact=False).click()
        audit.page.get_by_role('button', name='查看 Auto Mode 详情', exact=True).click()
        output = audit.page.locator('.plugin-panel-card pre')
        expect(output).to_contain_text('AUTO_TIMEOUT_START')
        expect(output).to_contain_text('timed out after 30000 ms')
        output.scroll_into_view_if_needed()
        audit.page.screenshot(path='/tmp/pih-auto-mode-timeout.png')
        audit.finish()
        print('real_model_default_timeout_zero_exit_handler_stdout_stderr_panel PASS', flush=True)
    finally:
        try:
            restored = audit.page.request.post(BASE + '/api/session/open', data={'path': original['sessionFile']})
            assert restored.ok, f'Session restore HTTP {restored.status}'
            audit.page.goto(BASE, wait_until='domcontentloaded')
            assert audit.page.request.get(BASE + '/api/session').json()['sessionId'] == original['sessionId']
            print('original_session_restored PASS', flush=True)
        finally:
            audit.close()
