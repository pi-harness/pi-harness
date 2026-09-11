"""Real gate/providers in an explicitly supplied synthetic Git/npm workspace."""
import argparse
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser, BASE

parser = argparse.ArgumentParser()
parser.add_argument('workspace')
args = parser.parse_args()
root = '/Volumes/librefang/worktrees/plugin-functional-verification'
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['change-verifier', 'test-harness', 'reviewer-bot'], new_session=False)
    try:
        response = audit.page.request.post(BASE + '/api/session/new', data={'cwd': args.workspace})
        assert response.ok, response.status
        audit.page.goto(BASE, wait_until='networkidle')
        passed = audit.invoke('verify_change_gate', {'script': 'test'})
        assert not passed['isError']
        assert passed['details']['status'] == 'pass'
        assert passed['details']['tests']['exitCode'] == 0
        audit.panel('Change Verifier', ['门禁通过'])
        panels = audit.page.request.get(BASE + '/api/plugin-ui').json()['items']
        test = next(item['data']['latest'] for item in panels if item['id'] == 'test-harness-panel')
        review = next(item['data']['latest'] for item in panels if item['id'] == 'reviewer-bot-panel')
        assert test['cwd'] == review['cwd'] == args.workspace
        assert 'GATE_FIXTURE_OK' in test['output']
        failed = audit.invoke('verify_change_gate', {'script': 'lint'})
        assert not failed['isError']
        assert failed['details']['status'] == 'fail'
        assert failed['details']['tests']['exitCode'] == 7
        audit.panel('Change Verifier', ['门禁失败'])
        audit.finish()
        print('actual_git_npm_gate_pass_fail PASS', flush=True)
    finally:
        restored = audit.page.request.post(BASE + '/api/session/new', data={'cwd': root})
        assert restored.ok, restored.status
        audit.close()
