"""Real read-only audit of synthetic text; never executes the scanned commands."""
import argparse
import hashlib
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import LivePluginBrowser, BASE

parser = argparse.ArgumentParser()
parser.add_argument('--retained', action='store_true', help='Reuse the real populated result after a UI-only fix')
args = parser.parse_args()
root = Path('/Volumes/librefang/worktrees/plugin-functional-verification')
relative = 'scripts/fixtures/plugin-verification/secure-audit'
files = [root / relative / name for name in ['cases.txt', 'clean.txt']]
before = [hashlib.sha256(file.read_bytes()).hexdigest() for file in files]

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['secure-audit'], new_session=not args.retained)
    try:
        def data():
            response = audit.page.request.get(BASE + '/api/plugin-ui')
            assert response.ok
            return next(item['data'] for item in response.json()['items'] if item['id'] == 'secure-audit-panel')
        if not args.retained:
            audit.panel('Secure Audit', ['尚未扫描。'])
            result = audit.invoke('security_audit', {'path': relative + '/cases.txt'})
            assert not result['isError']
            report = result['details']
            assert 'LOCAL_AUDIT_NOT_A_REAL_CREDENTIAL_12345' not in json.dumps(result)
            assert 'Heuristic checks do not prove safety.' in result['content'][0]['text']
            for line in range(1, 9):
                assert f'cases.txt:{line} ' in result['content'][0]['text']
        report = data()
        assert report['root'] == relative + '/cases.txt'
        assert report['scanned'] == 1 and report['total'] == 8
        assert report['critical'] == 2 and report['high'] == 6
        assert not report['incomplete'] and not report['truncated']
        assert [item['line'] for item in report['findings']] == list(range(1, 9))
        audit.page.get_by_role('button', name='插件，已安装', exact=False).click()
        audit.page.get_by_role('button', name='查看 Secure Audit 详情', exact=True).click()
        audit.page.screenshot(path='/tmp/pih-secure-audit-findings.png')
        for item in report['findings']:
            row = audit.page.get_by_text(f"第 {item['line']} 行 · {item['message']}", exact=True)
            row.scroll_into_view_if_needed()
            expect(row).to_be_visible()
        audit.page.screenshot(path='/tmp/pih-secure-audit-findings.png')
        assert 'LOCAL_AUDIT_NOT_A_REAL_CREDENTIAL_12345' not in audit.page.locator('body').inner_text()
        print('all_eight_redacted_findings_visible PASS', flush=True)
        audit.page.locator('button.session-row.active').click()
        clean = audit.invoke('security_audit', {'path': relative + '/clean.txt'})
        assert not clean['isError'] and clean['details']['total'] == 0
        assert not clean['details']['incomplete'] and not clean['details']['changed']
        audit.panel('Secure Audit', ['本次扫描范围内未命中规则，不代表安全。'])
        retained = data()
        missing = audit.invoke('security_audit', {'path': relative + '/nonexistent-audit-file.txt'})
        assert missing['isError']
        assert data() == retained
        assert [hashlib.sha256(file.read_bytes()).hexdigest() for file in files] == before
        audit.new_session()
        audit.panel('Secure Audit', ['尚未扫描。'])
        assert not data()['hasRun']
        audit.finish()
        print('secure_audit_redaction_no_mutation_failure_retention_reset PASS', flush=True)
    finally:
        audit.close()
