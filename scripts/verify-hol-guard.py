"""Actual model scans inert text; no destructive command is executed."""
import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser

ROOT = Path(__file__).resolve().parent.parent
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['hol-guard'], new_session=False, wait_until='domcontentloaded')
    original = audit.page.request.get(BASE + '/api/session').json()
    assert original.get('sessionFile') and Path(original['sessionFile']).is_file()
    try:
        assert audit.page.request.post(BASE + '/api/session/new', data={'cwd': str(ROOT)}).ok
        audit.page.goto(BASE, wait_until='domcontentloaded')
        params = {'text': 'rm -rf SYNTHETIC_NONEXISTENT_FIXTURE', 'source': audit.marker}
        result = audit.invoke('hol_guard_scan', params)
        assert not result['isError']
        report = result['details']
        assert json.loads(result['content'][0]['text']) == report
        assert report['risk'] == 'blocked' and report['source'] == audit.marker
        assert report['scannedBytes'] == len(params['text'].encode())
        assert report['findings']
        panel = next(x['data'] for x in audit.page.request.get(BASE + '/api/plugin-ui').json()['items'] if x['id'] == 'hol-guard-panel')
        assert panel['mode'] == 'audit' and panel['latest'] == report
        assert params['text'] not in json.dumps(panel)
        audit.panel('HOL Guard', ['检测到可能删除、重置或覆盖数据的命令。'])
        audit.page.get_by_role('button', name=re.compile(r'^插件，已安装')).click()
        audit.page.get_by_role('button', name='查看 HOL Guard 详情', exact=True).click()
        expect(audit.page.locator('.plugin-panel-card').get_by_text(re.compile('HOL Guard 不会阻止任何工具执行'))).to_be_visible()
        audit.finish()
        print('actual_model_full_risk_report_advisory_panel PASS', flush=True)
    finally:
        try:
            restored = audit.page.request.post(BASE + '/api/session/open', data={'path': original['sessionFile']})
            assert restored.ok, f'Session restore HTTP {restored.status}'
            audit.page.goto(BASE, wait_until='domcontentloaded')
            assert audit.page.request.get(BASE + '/api/session').json()['sessionId'] == original['sessionId']
            print('original_session_restored PASS', flush=True)
        finally:
            audit.close()
