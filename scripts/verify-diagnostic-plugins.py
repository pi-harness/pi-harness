"""Live model/tool/UI checks; requires the source audit profile on port 3144."""
import json
import re
from uuid import uuid4
from playwright.sync_api import sync_playwright, expect

BASE = 'http://127.0.0.1:3144'
with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless=False,
    )
    try:
        page = browser.new_page(viewport={'width': 1440, 'height': 960})
        errors = []
        open_requests = []
        run_marker = 'DIAGNOSTIC_' + uuid4().hex[:8]
        page.on('request', lambda request: open_requests.append(request.post_data_json)
                if request.method == 'POST' and request.url.endswith('/api/session/open') else None)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(BASE, wait_until='networkidle')
        plugins = page.request.get(BASE + '/api/plugins').json()['items']
        for name in ['yaml-validator', 'context-doctor', 'session-insights']:
            assert any(x['name'] == '@pi-harness/plugin-' + name and x['state'] == 'active' for x in plugins)
        page.get_by_role('button', name='新建会话', exact=False).click()
        page.get_by_role('dialog').get_by_role('button').filter(has_text='plugin-functional-verification').click()
        expect(page.get_by_role('dialog')).not_to_be_visible()
        expect(page.get_by_role('textbox', name='Prompt', exact=True)).to_be_visible()
        def messages():
            return page.request.get(BASE + '/api/session').json()['messages']

        def invoke(tool, params):
            before = len(messages())
            page.get_by_role('textbox', name='Prompt', exact=True).fill(
                f'{run_marker} 这是插件功能验证。只调用一次 {tool}，参数严格为 {json.dumps(params)}。'
                '不要调用其他工具，不要修复文件，不要压缩会话。工具返回后只回复“验证完成”，即使工具返回错误也不要重试。'
            )
            with page.expect_response(lambda r: r.url.endswith('/api/prompt'), timeout=180000) as pending:
                page.get_by_role('button', name='发送消息', exact=True).click()
            assert pending.value.ok, f'{tool}: prompt failed: {pending.value.status}'
            current = messages()[before:]
            calls = [part for m in current for part in m.get('content', [])
                     if isinstance(part, dict) and part.get('type') == 'toolCall']
            assert len(calls) == 1 and calls[0]['name'] == tool, [(x['name']) for x in calls]
            assert calls[0]['arguments'] == params
            results = [m for m in current if m.get('role') == 'toolResult']
            assert len(results) == 1 and results[0]['toolName'] == tool
            print(tool, {'isError': results[0].get('isError')}, flush=True)
            expect(page.locator('.turn.text:not(.streaming-turn)').last).to_be_visible()
            return results[0]

        def panel(title, expected):
            panel_before = page.request.get(BASE + '/api/plugin-ui').json()['items']
            page.get_by_role('button', name=re.compile(r'^插件，已安装')).click()
            page.get_by_role('button', name=f'查看 {title} 详情', exact=True).click()
            item = page.get_by_text(expected, exact=True)
            expect(item).to_be_visible()
            item.scroll_into_view_if_needed()
            page.screenshot(path='/tmp/pih-' + title.lower().replace(' ', '-') + '.png')
            print(title + ' rendered panel PASS', flush=True)
            # Return to this session without creating a new one or resetting panel state.
            opens_before = len(open_requests)
            page.locator('button.session-row.active').click()
            expect(page.get_by_role('textbox', name='Prompt', exact=True)).to_be_visible()
            panel_after = page.request.get(BASE + '/api/plugin-ui').json()['items']
            assert len(open_requests) == opens_before, 'Active-session navigation must not reopen the runtime'
            if title == 'YAML Validator':
                old = next(x['data'] for x in panel_before if x['id'] == 'yaml-validator-panel')
                new = next(x['data'] for x in panel_after if x['id'] == 'yaml-validator-panel')
                assert new == old, 'Returning to the active chat must preserve YAML diagnostics'

        result = invoke('yaml_validate', {'path': 'scripts/fixtures/plugin-verification/valid.yaml'})
        assert not result['isError'] and result['details']['valid'] is True
        panel('YAML Validator', 'YAML 语法有效。')
        result = invoke('yaml_validate', {'path': 'scripts/fixtures/plugin-verification/invalid.yaml'})
        assert not result['isError'] and result['details']['valid'] is False
        assert result['details']['errors'][0]['line'] == 2
        panel('YAML Validator', '发现 1 个语法错误。')
        result = invoke('yaml_validate', {'path': 'scripts/fixtures/plugin-verification/missing.yaml'})
        assert result['isError'] is True
        yaml_state = next(x['data'] for x in page.request.get(BASE + '/api/plugin-ui').json()['items']
                          if x['id'] == 'yaml-validator-panel')
        assert yaml_state['status']['state'] == 'failed'
        panel('YAML Validator', '最近一次校验失败。' + yaml_state['status']['error'])
        result = invoke('context_doctor', {})
        assert not result['isError'] and result['details']['toolErrors'] >= 1
        panel('Context Doctor', '需要关注上下文风险。')
        result = invoke('session_report', {})
        assert not result['isError'] and result['details']['toolCalls'] >= 4
        assert result['details']['compaction']['status'] == 'idle'
        panel('Session Insights', '尚未请求压缩')
        first_session = page.request.get(BASE + '/api/session').json()
        first_title = page.locator('button.session-row.active .session-copy strong').inner_text()
        before_settings = len(open_requests)
        page.get_by_role('button', name='设置', exact=True).click()
        page.locator('button.session-row.active').click()
        expect(page.get_by_role('textbox', name='Prompt', exact=True)).to_be_visible()
        assert page.request.get(BASE + '/api/session').json()['sessionFile'] == first_session['sessionFile']
        assert len(open_requests) == before_settings
        print('settings_to_active_chat_without_reopen PASS', flush=True)
        page.get_by_role('button', name='新建会话', exact=False).click()
        page.get_by_role('dialog').get_by_role('button').filter(has_text='plugin-functional-verification').click()
        expect(page.get_by_role('dialog')).not_to_be_visible()
        expect(page.get_by_role('textbox', name='Prompt', exact=True)).to_be_visible()
        second_session = page.request.get(BASE + '/api/session').json()
        assert second_session['sessionFile'] != first_session['sessionFile']
        yaml_state = next(x['data'] for x in page.request.get(BASE + '/api/plugin-ui').json()['items']
                          if x['id'] == 'yaml-validator-panel')
        assert yaml_state['latest'] is None and yaml_state['status']['state'] == 'idle'
        before_switch = len(open_requests)
        with page.expect_response(lambda r: r.url.endswith('/api/session/open')) as opened:
            page.locator('button.session-row').filter(has=page.get_by_text(first_title, exact=True)).click()
        assert opened.value.ok
        assert len(open_requests) == before_switch + 1
        assert open_requests[-1]['path'] == first_session['sessionFile']
        assert page.request.get(BASE + '/api/session').json()['sessionFile'] == first_session['sessionFile']
        print('different_session_switch_and_new_session_reset PASS', flush=True)
        assert not errors, errors
        print('diagnostic_plugins PASS', flush=True)
    except Exception as error:
        print('verification_failed', type(error).__name__, str(error), flush=True)
        raise
    finally:
        browser.close()
