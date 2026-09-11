"""Native new-session resets a previous gate; inspect final reviewer metadata."""
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser, BASE

root = '/Volumes/librefang/worktrees/plugin-functional-verification'
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['change-verifier', 'reviewer-bot'], new_session=False)
    try:
        audit.panel('Reviewer Bot', ['只读检查相对 HEAD 的已跟踪 Git 改动中的空白错误、疑似凭据和 TODO/FIXME 标记；不含未跟踪文件，不执行测试，也不代替语义代码审查。'])
        def create(cwd):
            response = audit.page.request.post(BASE + '/api/session/new', data={'cwd': cwd})
            assert response.ok
            audit.page.goto(BASE, wait_until='networkidle')
        def gate():
            response = audit.page.request.get(BASE + '/api/plugin-ui')
            assert response.ok
            return next(item['data'] for item in response.json()['items'] if item['id'] == 'change-verifier-panel')
        create('/tmp/pih-change-gate-K44xvn')
        result = audit.invoke('verify_change_gate', {'script': 'test'})
        assert not result['isError'] and result['details']['status'] == 'warning'
        assert gate()['runs'] == 1
        audit.panel('Change Verifier', ['门禁有警告'])
        create(root)
        assert gate() == {'runs': 0, 'latest': None}
        audit.panel('Change Verifier', ['还没有执行发布门禁。可让 Agent 调用 verify_change_gate。'])
        audit.finish()
        print('native_gate_scope_reset_and_reviewer_metadata PASS', flush=True)
    finally:
        audit.close()
