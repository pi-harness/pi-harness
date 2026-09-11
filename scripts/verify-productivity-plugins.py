"""Visible browser checks of native prompts and isolated SQLite task workflows."""
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser


with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['prompt-library', 'taskboard'])
    try:
        title = 'Template_' + audit.marker
        prompt = 'Review this synthetic patch and report its regression risks.'
        result = audit.invoke('prompt_library', {'action': 'save', 'title': title, 'prompt': prompt, 'tags': ['audit']}, allow_writes=True)
        assert not result['isError']
        template = result['details']['selected']
        template_id = template['id']
        assert template['prompt'] == prompt and template['tags'] == ['audit']
        audit.panel('Prompt Library', [title, prompt])
        revised = prompt + ' Include verification steps.'
        result = audit.invoke('prompt_library', {'action': 'save', 'id': template_id, 'prompt': revised}, allow_writes=True)
        assert not result['isError'] and result['details']['selected']['title'] == title
        result = audit.invoke('prompt_library', {'action': 'list', 'query': title})
        assert not result['isError'] and result['details']['templates'][0]['prompt'] == revised
        print('prompt_body_in_model_visible_list', any(revised in part.get('text', '') for part in result['content']), flush=True)
        original = audit.page.request.get(BASE + '/api/session').json()['sessionId']
        session_title = audit.page.locator('button.session-row.active .session-copy strong').inner_text()
        task_title = 'Task_' + audit.marker
        result = audit.invoke('taskboard_create', {'title': task_title, 'priority': 'high'}, allow_writes=True)
        assert not result['isError'] and result['details']['status'] == 'backlog'
        key = result['details']['key']
        assert key.startswith('AUD-')
        audit.panel('Taskboard', [task_title, key])
        result = audit.invoke('taskboard_accept', {'key': key, 'confirm': False}, allow_writes=True)
        assert result['isError']
        result = audit.invoke('taskboard_accept', {'key': key, 'confirm': True}, allow_writes=True)
        assert result['isError']
        for status in ['in_progress', 'in_review']:
            result = audit.invoke('taskboard_update', {'key': key, 'status': status}, allow_writes=True)
            assert not result['isError'] and result['details']['status'] == status
        result = audit.invoke('taskboard_accept', {'key': key, 'confirm': True}, allow_writes=True)
        assert not result['isError'] and result['details']['status'] == 'done'
        audit.new_session()
        result = audit.invoke('prompt_library', {'action': 'list'})
        assert not result['isError'] and result['details']['templates'] == []
        result = audit.invoke('taskboard_list', {'query': task_title})
        assert not result['isError'] and len(result['details']['tasks']) == 1
        assert result['details']['tasks'][0]['key'] == key and result['details']['tasks'][0]['status'] == 'done'
        with audit.page.expect_response(lambda r: r.url.endswith('/api/session/open')) as opened:
            audit.page.locator('button.session-row').filter(has=audit.page.get_by_text(session_title, exact=True)).click()
        assert opened.value.ok
        assert audit.page.request.get(BASE + '/api/session').json()['sessionId'] == original
        result = audit.invoke('prompt_library', {'action': 'list', 'query': title})
        assert not result['isError'] and result['details']['templates'][0]['prompt'] == revised
        audit.panel('Prompt Library', [title, revised])
        result = audit.invoke('prompt_library', {'action': 'get', 'id': template_id})
        assert not result['isError'] and result['content'] == [{'type': 'text', 'text': revised}]
        assert result['details']['selected']['id'] == template_id
        assert len(result['details']['templates']) == 1
        result = audit.invoke('prompt_library', {'action': 'delete', 'id': template_id}, allow_writes=True)
        assert not result['isError'] and result['details']['templates'] == []
        audit.panel('Prompt Library', ['还没有保存的提示词。可让 Agent 调用 prompt_library 保存模板。'])
        audit.finish()
        print('prompt_native_persistence_taskboard_workflow PASS', flush=True)
    except Exception as error:
        print('verification_failed', type(error).__name__, str(error), flush=True)
        raise
    finally:
        audit.close()
