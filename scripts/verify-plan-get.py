"""Read-only plan recovery through real model calls and a fresh browser page."""
import json
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser, BASE

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['plan-execute'])
    try:
        empty = audit.invoke('plan_get', {})
        assert empty['isError'] and 'No plan exists' in empty['content'][0]['text']
        created = audit.invoke('plan_create', {
            'title': '只读恢复计划😀', 'steps': ['检查实现', '确认交付'],
            'dependencies': [{'step': 2, 'dependsOn': [1]}],
        }, allow_writes=True)
        assert not created['isError']
        def panel_data():
            response = audit.page.request.get(BASE + '/api/plugin-ui')
            assert response.ok
            return next(x['data'] for x in response.json()['items'] if x['id'] == 'plan-execute-panel')
        before = panel_data()
        audit.page.reload(wait_until='networkidle')
        result = audit.invoke('plan_get', {})
        assert not result['isError']
        assert json.loads(result['content'][0]['text']) == result['details'] == created['details']
        assert panel_data() == before, 'Read-only retrieval changed plan state'
        audit.panel('Plan Execute', ['只读恢复计划😀', '0 / 2', '检查实现', '确认交付', '依赖步骤 1'])
        audit.finish()
        print('plan_get_empty_readonly_reload PASS', flush=True)
    finally:
        audit.close()
