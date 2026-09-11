"""Real standalone provider calls in an owned small Git/npm fixture."""
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser, BASE

root = '/Volumes/librefang/worktrees/plugin-functional-verification'
workspace = '/tmp/pih-change-gate-K44xvn'
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['reviewer-bot', 'test-harness', 'change-verifier'], new_session=False)
    try:
        audit.panel('Change Verifier', ['执行本机命令'])
        changed = audit.page.request.post(BASE + '/api/session/new', data={'cwd': workspace})
        assert changed.ok
        audit.page.goto(BASE, wait_until='networkidle')
        review = audit.invoke('review_changes', {})
        assert not review['isError']
        assert review['details']['cwd'] == workspace
        assert review['details']['status'] == 'warning'
        assert review['details']['findingCount'] == 1
        assert review['details']['findings'][0]['path'] == 'package.json'
        audit.panel('Reviewer Bot', ['需要关注'])
        tested = audit.invoke('run_project_tests', {'script': 'test'})
        assert not tested['isError']
        assert tested['details']['cwd'] == workspace
        assert tested['details']['status'] == 'passed'
        assert tested['details']['exitCode'] == 0
        assert 'GATE_FIXTURE_OK' in tested['details']['output']
        audit.panel('Test Harness', ['验证通过', 'exit 0'])
        audit.finish()
        print('standalone_review_warning_test_output_and_capability PASS', flush=True)
    finally:
        restored = audit.page.request.post(BASE + '/api/session/new', data={'cwd': root})
        assert restored.ok
        audit.close()
