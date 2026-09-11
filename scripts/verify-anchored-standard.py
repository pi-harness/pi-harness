"""Trigger real audit-only allowlist/budget violations in headed Chrome."""
import argparse
import json
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser

parser = argparse.ArgumentParser()
parser.add_argument('--baseline', action='store_true')
args = parser.parse_args()

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['anchored-standard', 'runtime-doctor'])
    try:
        first = audit.invoke('trajectory_anchor_check', {})
        assert not first['isError'] and first['details']['status'] == 'anchored'
        assert first['details']['violations'] == [] and first['details']['toolCalls'] == 1
        audit.panel('Anchored Standard', ['等待 Agent 运行'])
        before = len(audit.messages())
        audit.page.get_by_role('textbox', name='Prompt', exact=True).fill(
            f'{audit.marker} 独立审计测试：先调用一次 runtime_doctor，参数为 {{}}；'
            '等它返回后再调用一次 trajectory_anchor_check，参数为 {}。'
            '这两个工具都是只读审计。本轮必须实际调用这两次，不能引用之前的结果。'
            '不要调用其他工具，不要改文件。最终仅回复：验证完成。'
        )
        with audit.page.expect_response(lambda r: r.url.endswith('/api/prompt'), timeout=180000) as pending:
            audit.page.get_by_role('button', name='发送消息', exact=True).click()
        assert pending.value.ok
        messages = audit.messages()[before:]
        calls = [part for m in messages for part in m.get('content', [])
                 if isinstance(part, dict) and part.get('type') == 'toolCall']
        assert [call['name'] for call in calls] == ['runtime_doctor', 'trajectory_anchor_check']
        assert all(call['arguments'] == {} for call in calls)
        results = [m for m in messages if m.get('role') == 'toolResult']
        assert len(results) == 2 and all(not m['isError'] for m in results), 'Audit must not block either read-only tool'
        result = results[-1]
        report = result['details']
        assert report['status'] == 'violated' and report['toolCalls'] == 2
        assert {item['code'] for item in report['violations']} == {'disallowed_tool', 'tool_budget'}
        text = result['content'][0]['text']
        fields = {'reasons': all(item['message'] in text for item in report['violations']),
                  'allowlist': 'trajectory_anchor_check' in text, 'budget': 'maxToolCalls' in text}
        print('anchor_model_fields', fields, flush=True)
        audit.panel('Anchored Standard', [item['message'] for item in report['violations']])
        if not args.baseline:
            assert json.loads(text) == report and all(fields.values())
            assert report['auditOnly'] is True and report['scope'] == 'since-plugin-load'
            audit.panel('Anchored Standard', ['告警自插件加载以来累计，跨会话保留；只读审计，不会阻止工具执行。'])
            audit.new_session()
            later = audit.invoke('trajectory_anchor_check', {})
            assert not later['isError']
            assert later['details']['toolCalls'] == 1
            assert later['details']['violations'] == report['violations']
            assert later['details']['events'] > report['events']
            assert json.loads(later['content'][0]['text']) == later['details']
            audit.panel('Anchored Standard', [item['message'] for item in report['violations']])
        audit.finish()
        print('anchored_baseline OBSERVED' if args.baseline else 'anchored_standard PASS', flush=True)
    finally:
        audit.close()
