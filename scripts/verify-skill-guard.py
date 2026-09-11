"""Headed scan of existing loaded skill metadata; no source text is printed."""
import json
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser, BASE

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['skill-guard'])
    try:
        def panel_data():
            response = audit.page.request.get(BASE + '/api/plugin-ui')
            assert response.ok
            return next(item['data'] for item in response.json()['items'] if item['id'] == 'skill-guard-panel')

        initial = panel_data()
        assert initial['status']['state'] == 'completed'
        result = audit.invoke('skill_guard_scan', {'query': 'pih-production-audit'})
        assert not result['isError']
        report = result['details']
        assert json.loads(result['content'][0]['text']) == report
        assert report['total'] == 1
        assert report['reports'][0]['name'] == 'pih-production-audit'
        assert report['inventory']['matched'] == 1
        assert not report['inventory']['truncated']
        assert 'Risk labels do not disable skills' in report['scope']
        assert all('content' not in item for item in report['reports'])
        audit.panel('Skill Guard', ['pih-production-audit'])
        print('actual_loaded_skill_full_report_and_panel PASS', flush=True)
        empty = audit.invoke('skill_guard_scan', {'query': 'pih-no-such-skill-8c570e'})
        assert not empty['isError']
        assert empty['details']['reports'] == []
        assert empty['details']['inventory']['matched'] == 0
        assert panel_data()['total'] == 0
        audit.panel('Skill Guard', ['暂无 Skill 扫描结果，可让 Agent 调用 skill_guard_scan。'])
        audit.finish()
        print('empty_query_result PASS', flush=True)
    finally:
        audit.close()
