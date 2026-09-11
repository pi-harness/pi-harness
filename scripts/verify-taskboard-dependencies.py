"""Actual-model dependency transactions in an owned Taskboard workspace."""
import json
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

workspace = str(Path(tempfile.mkdtemp(prefix='pih-taskboard-dependencies-')).resolve())
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['taskboard'], new_session=False, wait_until='domcontentloaded')
    original = audit.page.request.get(BASE + '/api/session').json()
    def call(tool, params, error=False):
        result = audit.invoke(tool, params, allow_writes=tool != 'taskboard_list')
        assert result['isError'] == error
        if not error:
            assert json.loads(result['content'][0]['text']) == result['details']
            return result['details']
        return result
    def tasks():
        panel = next(item for item in audit.page.request.get(BASE + '/api/plugin-ui').json()['items'] if item['id'] == 'taskboard-panel')
        assert panel['data']['workspace'] == workspace
        return {task['key']: task for task in panel['data']['recent']}
    try:
        assert audit.page.request.post(BASE + '/api/session/new', data={'cwd': workspace}).ok
        audit.page.goto(BASE, wait_until='domcontentloaded')
        a = call('taskboard_create', {'title': 'Owned prerequisite', 'dueDate': '2028-02-29'})
        b = call('taskboard_create', {'title': 'Owned dependent', 'dependsOn': [a['key']]})
        before = tasks()
        assert before[a['key']]['dueDate'] == '2028-02-29'
        call('taskboard_update', {'key': a['key'], 'title': 'Must roll back', 'dependsOn': [b['key']]}, error=True)
        assert tasks() == before, 'Cycle rejection partially updated task fields or dependencies'
        print('cycle_transaction_rollback PASS', flush=True)
        call('taskboard_update', {'key': a['key'], 'dueDate': '2027-02-29'}, error=True)
        assert tasks() == before, 'Invalid date changed persisted task'
        print('invalid_calendar_date_rejected PASS', flush=True)
        call('taskboard_update', {'key': b['key'], 'status': 'in_review'})
        before = tasks()
        call('taskboard_accept', {'key': b['key'], 'confirm': True}, error=True)
        assert tasks() == before, 'Unfinished prerequisite changed acceptance state'
        print('unfinished_prerequisite_blocks_acceptance PASS', flush=True)
        audit.panel('Taskboard', ['Owned prerequisite', 'Owned dependent', '截止 2028-02-29'])
        call('taskboard_update', {'key': a['key'], 'status': 'in_review', 'clearDueDate': True})
        assert 'dueDate' not in tasks()[a['key']]
        assert call('taskboard_accept', {'key': a['key'], 'confirm': True})['status'] == 'done'
        assert call('taskboard_accept', {'key': b['key'], 'confirm': True})['status'] == 'done'
        report = call('taskboard_list', {})
        assert report['total'] == 2 and all(task['status'] == 'done' for task in report['tasks'])
        assert next(task for task in report['tasks'] if task['key'] == b['key'])['dependsOn'] == [a['key']]
        audit.panel('Taskboard', ['Owned prerequisite', 'Owned dependent'])
        audit.finish()
        print('actual_model_dependency_completion PASS', flush=True)
        print('owned_workspace_retained', workspace, flush=True)
    finally:
        try:
            response = audit.page.request.post(BASE + '/api/session/open', data={'path': original['sessionFile']})
            assert response.ok and response.json()['sessionId'] == original['sessionId']
            audit.page.goto(BASE, wait_until='domcontentloaded')
        finally:
            audit.close()
