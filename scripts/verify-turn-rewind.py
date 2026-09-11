"""Real native session branch rewind with two harmless model turns."""
import json
import time
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser, BASE

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['turn-rewind'], new_session=True)
    try:
        # Populate two ordinary user turns; model instruction forbids all tools.
        for prompt in ['回复唯一单词 alpha，不调用工具。', '回复唯一单词 beta，不调用工具。']:
            with audit.page.expect_response(lambda r: r.url.endswith('/api/prompt')) as pending:
                audit.page.get_by_role('textbox', name='Prompt', exact=True).fill(prompt)
                audit.page.get_by_role('button', name='发送消息', exact=True).click()
            assert pending.value.ok
            assert audit.messages()[-1]['role'] == 'assistant'
        result = audit.invoke('session_rewind', {'turns': 1}, retained_history=True)
        assert not result['isError']
        details = result['details']
        if details['status'] == 'queued':
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                panels = audit.page.request.get(BASE + '/api/plugin-ui').json()['items']
                details = next(item['data']['latest'] for item in panels if item['id'] == 'turn-rewind-panel')
                if details['status'] != 'queued':
                    break
                time.sleep(0.1)
        assert details['status'] == 'completed', details
        assert details['target']['text']
        assert details.get('editorText') == details['target']['text']
        session = audit.page.request.get(BASE + '/api/session')
        assert session.ok
        assert session.json()['sessionId']
        audit.panel('Turn Rewind', ['已回退'])
        audit.finish()
        print('native_turn_rewind_real_branch PASS', flush=True)
    finally:
        audit.close()
