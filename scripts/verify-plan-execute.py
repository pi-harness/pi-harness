"""Actual plan creation, dependency refusal and advancement in headed Chrome."""
import json
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['plan-execute'])
    try:
        params = {'title': '发布验证😀', 'steps': ['验证构建', '发布候选'],
                  'dependencies': [{'step': 2, 'dependsOn': [1]}]}
        result = audit.invoke('plan_create', params, allow_writes=True)
        expected = {'title': params['title'], 'steps': [
            {'id': 1, 'title': '验证构建', 'status': 'pending'},
            {'id': 2, 'title': '发布候选', 'status': 'pending', 'dependsOn': [1]},
        ]}
        assert not result['isError']
        assert json.loads(result['content'][0]['text']) == result['details'] == expected
        audit.panel('Plan Execute', ['发布验证😀', '0 / 2', '验证构建', '发布候选', '依赖步骤 1'])
        blocked = audit.invoke('plan_advance', {'step': 2, 'status': 'in_progress'}, allow_writes=True)
        assert blocked['isError'] and 'dependencies' in blocked['content'][0]['text']
        panels = audit.page.request.get('http://127.0.0.1:3144/api/plugin-ui').json()['items']
        data = next(x['data'] for x in panels if x['id'] == 'plan-execute-panel')
        assert data['steps'] == expected['steps'] and data['completed'] == 0
        for step in [1, 2]:
            result = audit.invoke('plan_advance', {'step': step, 'status': 'done'}, allow_writes=True)
            expected['steps'][step - 1]['status'] = 'done'
            assert not result['isError']
            assert json.loads(result['content'][0]['text']) == result['details'] == expected
        audit.panel('Plan Execute', ['发布验证😀', '2 / 2', '验证构建', '发布候选', '依赖步骤 1'])
        audit.finish()
        print('plan_create_dependency_rejection_advance PASS', flush=True)
    finally:
        audit.close()
