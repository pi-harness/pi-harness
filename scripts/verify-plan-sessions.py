"""Verify persisted plans remain separate across real headed session navigation."""
import json
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import LivePluginBrowser, BASE

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['plan-execute'])
    try:
        def state():
            response = audit.page.request.get(BASE + '/api/session')
            assert response.ok
            data = response.json()
            return {'id': data['sessionId'],
                    'title': audit.page.locator('button.session-row.active .session-copy strong').inner_text()}
        def panel_data():
            response = audit.page.request.get(BASE + '/api/plugin-ui')
            assert response.ok
            return next(x['data'] for x in response.json()['items'] if x['id'] == 'plan-execute-panel')
        def open_session(saved):
            with audit.page.expect_response(lambda r: r.url.endswith('/api/session/open')) as opened:
                audit.page.locator('button.session-row').filter(has=audit.page.get_by_text(saved['title'], exact=True)).click()
            assert opened.value.ok
            expect(audit.page.get_by_role('textbox', name='Prompt', exact=True)).to_be_visible()
            assert state()['id'] == saved['id']

        created = audit.invoke('plan_create', {'title': '会话 A 交付计划😀', 'steps': ['检查', '交付'],
                               'dependencies': [{'step': 2, 'dependsOn': [1]}]}, allow_writes=True)
        assert not created['isError']
        advanced = audit.invoke('plan_advance', {'step': 1, 'status': 'done'}, allow_writes=True)
        assert not advanced['isError']
        first = state()
        expected_first = panel_data()
        assert expected_first['completed'] == 1
        audit.new_session()
        assert panel_data() == {'title': None, 'completed': 0, 'total': 0, 'steps': []}, 'New session leaked previous plan'
        audit.panel('Plan Execute', ['尚未创建计划', '0 / 0', 'Agent 可调用 plan_create 创建执行计划。'])
        # Distinct audit markers ensure sidebar titles identify each synthetic session uniquely.
        audit.marker += '_SECOND'
        second_result = audit.invoke('plan_create', {'title': '会话 B 独立计划', 'steps': ['整理']}, allow_writes=True)
        assert not second_result['isError']
        second = state()
        expected_second = panel_data()
        assert first['id'] != second['id']
        open_session(first)
        assert panel_data() == expected_first
        recovered = audit.invoke('plan_get', {})
        assert not recovered['isError']
        assert json.loads(recovered['content'][0]['text']) == recovered['details'] == advanced['details']
        assert panel_data() == expected_first
        audit.panel('Plan Execute', ['会话 A 交付计划😀', '1 / 2', '依赖步骤 1'])
        open_session(second)
        assert panel_data() == expected_second
        audit.page.reload(wait_until='networkidle')
        assert panel_data() == expected_second
        audit.panel('Plan Execute', ['会话 B 独立计划', '0 / 1', '整理'])
        audit.finish()
        print('plan_session_isolation_native_reopen_recovery PASS', flush=True)
    finally:
        audit.close()
