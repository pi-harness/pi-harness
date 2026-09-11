"""Check a new session does not display the previous synthetic plan; no model calls."""
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser, BASE

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['plan-execute'], new_session=False)
    try:
        def plan():
            response = audit.page.request.get(BASE + '/api/plugin-ui')
            assert response.ok
            return next(x['data'] for x in response.json()['items'] if x['id'] == 'plan-execute-panel')
        before = plan()
        assert before['title'] == '发布验证😀', 'Requires retained synthetic plan from verify-plan-execute.py'
        audit.new_session()
        audit.page.get_by_role('button', name='插件，已安装', exact=False).click()
        audit.page.get_by_role('button', name='查看 Plan Execute 详情', exact=True).click()
        audit.page.screenshot(path='/tmp/pih-plan-session-retained.png')
        after = plan()
        assert after['title'] is None and after['steps'] == [], 'New session incorrectly retains previous session plan'
        audit.finish()
        print('plan_session_isolation PASS', flush=True)
    finally:
        audit.close()
