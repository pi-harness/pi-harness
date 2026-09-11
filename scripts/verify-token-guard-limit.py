"""A real provider run must stop before a second tool turn at a one-token budget."""
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser

def guard(audit):
    return next(x['data'] for x in audit.page.request.get(BASE + '/api/plugin-ui').json()['items'] if x['id'] == 'token-guard-panel')

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['token-guard', 'runtime-doctor', 'yaml-validator'])
    try:
        assert guard(audit)['maxRunTokens'] == 1
        audit.page.get_by_role('textbox', name='Prompt', exact=True).fill(
            audit.marker + ' 限额验证：先仅调用一次 runtime_doctor，参数 {}。'
            '等待它返回后，下一轮才调用 yaml_validate，参数 {"path":"scripts/fixtures/plugin-verification/missing-budget-test.yml"}。'
            '不要并行调用，不要修改文件，不要调用其他工具。两步都完成才回复“全部步骤完成”。'
        )
        with audit.page.expect_response(lambda r: r.url.endswith('/api/prompt'), timeout=180000) as pending:
            audit.page.get_by_role('button', name='发送消息', exact=True).click()
        assert pending.value.ok, pending.value.status
        assert pending.value.json().get('aborted') is True
        state = audit.page.request.get(BASE + '/api/session').json()
        assistants = [m for m in state['messages'] if m.get('role') == 'assistant']
        calls = [part for m in assistants for part in m.get('content', []) if isinstance(part, dict) and part.get('type') == 'toolCall']
        assert calls and calls[0]['name'] == 'runtime_doctor' and calls[0]['arguments'] == {}
        assert all(c['name'] != 'yaml_validate' for c in calls), 'second tool ran despite exceeded budget'
        assert len(assistants) == 2 and assistants[-1]['stopReason'] == 'aborted'
        assert assistants[-1]['usage']['output'] == 0 and assistants[-1]['usage']['input'] == 0
        snapshot = guard(audit)
        assert snapshot['aborts'] == 1 and snapshot['runExceeded'] and snapshot['exceeded']
        assert snapshot['runTokens'] >= 1 and snapshot['lastError'] is None
        expect(audit.page.get_by_role('button', name='发送消息', exact=True)).to_be_visible()
        expect(audit.page.locator('.turn-stopped').last).to_have_text('已中断')
        audit.page.reload(wait_until='networkidle')
        expect(audit.page.locator('.turn-stopped').last).to_have_text('已中断')
        audit.panel('Token Guard', ['上下文预算', '本次运行已报告用量'])
        print('real_run_stopped_before_second_tool PASS', flush=True)
        audit.new_session()
        fresh = guard(audit)
        assert fresh['aborts'] == 0 and fresh['runTokens'] is None and not fresh['runExceeded'] and fresh['lastError'] is None
        audit.finish()
    finally:
        audit.close()
