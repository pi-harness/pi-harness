"""Actual model + real Git/npm: gate pass, provider exceptions, then recovery."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

with tempfile.TemporaryDirectory(prefix='pih-change-gate-failure-') as temporary, sync_playwright() as p:
    workspace = Path(temporary).resolve()
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=workspace)
    git('init', '-q', '-b', 'main')
    (workspace / 'package.json').write_text(json.dumps({'name': 'owned-gate-fixture', 'private': True,
        'scripts': {'test': 'node -e "process.stdout.write(\'GATE_FIXTURE_OK\')"'}}) + '\n')
    git('add', 'package.json')
    git('-c', 'user.name=Gate Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
    audit = LivePluginBrowser(p, ['change-verifier', 'test-harness', 'reviewer-bot'], new_session=False, wait_until='domcontentloaded')
    original = audit.page.request.get(BASE + '/api/session').json()
    assert original.get('sessionFile')
    def gate_state():
        return next(item['data'] for item in audit.page.request.get(BASE + '/api/plugin-ui').json()['items']
                    if item['id'] == 'change-verifier-panel')
    try:
        assert audit.page.request.post(BASE + '/api/session/new', data={'cwd': str(workspace)}).ok
        audit.page.goto(BASE, wait_until='domcontentloaded')
        passed = audit.invoke('verify_change_gate', {'script': 'test'})
        assert not passed['isError'] and passed['details']['status'] == 'pass'
        assert gate_state()['status'] == 'completed' and gate_state()['runs'] == 1
        audit.panel('Change Verifier', ['门禁通过'])

        # Approved-provider policy rejects this name before starting npm.
        failed = audit.invoke('verify_change_gate', {'script': 'not-approved'})
        assert failed['isError']
        state = gate_state()
        assert state['latest'] is None and state['status'] == 'failed' and state['runs'] == 1
        assert 'approved verification script' in state['lastError']
        audit.panel('Change Verifier', ['验证失败', state['lastError']])
        shutil.copyfile('/tmp/pih-change-verifier.png', '/tmp/pih-gate-test-provider-error.png')

        # Only the owned fixture HEAD changes; its original main ref remains intact.
        git('symbolic-ref', 'HEAD', 'refs/heads/owned-unborn')
        failed = audit.invoke('verify_change_gate', {'script': 'test'})
        assert failed['isError']
        state = gate_state()
        assert state['latest'] is None and state['status'] == 'failed' and state['runs'] == 1
        assert state['lastError']
        audit.panel('Change Verifier', ['验证失败', state['lastError']])
        shutil.copyfile('/tmp/pih-change-verifier.png', '/tmp/pih-gate-review-provider-error.png')

        git('symbolic-ref', 'HEAD', 'refs/heads/main')
        recovered = audit.invoke('verify_change_gate', {'script': 'test'})
        assert not recovered['isError'] and recovered['details']['status'] == 'pass'
        state = gate_state()
        assert state['status'] == 'completed' and state['runs'] == 2 and state['lastError'] is None
        audit.panel('Change Verifier', ['门禁通过'])
        audit.finish()
        print('actual_model_gate_pass_provider_errors_recovery PASS', flush=True)
    finally:
        try:
            assert audit.page.request.post(BASE + '/api/session/open', data={'path': original['sessionFile']}).ok
            audit.page.goto(BASE, wait_until='domcontentloaded')
            assert audit.page.request.get(BASE + '/api/session').json()['sessionId'] == original['sessionId']
            print('original_session_restored PASS', flush=True)
        finally:
            audit.close()
