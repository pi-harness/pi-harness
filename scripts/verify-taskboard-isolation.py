"""Actual-model cross-workspace refusal against retained owned tasks."""
import json
from pathlib import Path
import sys
import tempfile
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

source = str(Path(sys.argv[1]).resolve(strict=True))
assert Path(source).name.startswith('pih-taskboard-dependencies-')
other = str(Path(tempfile.mkdtemp(prefix='pih-taskboard-isolation-')).resolve())
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['taskboard'], new_session=False, wait_until='domcontentloaded')
    original = audit.page.request.get(BASE + '/api/session').json()
    def switch(workspace):
        assert audit.page.request.post(BASE + '/api/session/new', data={'cwd': workspace}).ok
        audit.page.goto(BASE, wait_until='domcontentloaded')
    def panel_data():
        panel = next(item for item in audit.page.request.get(BASE + '/api/plugin-ui').json()['items'] if item['id'] == 'taskboard-panel')
        assert not panel.get('error')
        return panel['data']
    def call(tool, params, error=False):
        result = audit.invoke(tool, params, allow_writes=tool != 'taskboard_list')
        assert result['isError'] == error
        if error:
            return result
        assert json.loads(result['content'][0]['text']) == result['details']
        return result['details']
    try:
        switch(source)
        baseline = panel_data()
        assert baseline['workspace'] == source and baseline['total'] == 2
        assert {task['title'] for task in baseline['recent']} == {'Owned prerequisite', 'Owned dependent'}
        foreign = baseline['recent'][0]['key']
        switch(other)
        report = call('taskboard_list', {})
        assert report['workspace'] == other and report['total'] == 0 and not report['tasks']
        result = call('taskboard_update', {'key': foreign, 'title': 'Must not cross workspace'}, error=True)
        assert 'not found' in result['content'][0]['text'].lower()
        call('taskboard_create', {'title': 'Must roll back foreign dependency', 'dependsOn': [foreign]}, error=True)
        empty = panel_data()
        assert empty['workspace'] == other and empty['total'] == 0 and not empty['recent']
        print('foreign_read_update_dependency_and_partial_insert_protection PASS', flush=True)
        local = call('taskboard_create', {'title': 'Owned isolated recovery'})
        assert local['workspace'] == other and not local['dependsOn']
        audit.panel('Taskboard', ['Owned isolated recovery'])
        switch(source)
        assert panel_data() == baseline, 'Cross-workspace operations changed source tasks'
        audit.panel('Taskboard', ['Owned prerequisite', 'Owned dependent'])
        audit.finish()
        print('source_tasks_unchanged_and_local_recovery PASS', flush=True)
        print('owned_workspace_retained', other, flush=True)
    finally:
        try:
            response = audit.page.request.post(BASE + '/api/session/open', data={'path': original['sessionFile']})
            assert response.ok and response.json()['sessionId'] == original['sessionId']
            audit.page.goto(BASE, wait_until='domcontentloaded')
        finally:
            audit.close()
