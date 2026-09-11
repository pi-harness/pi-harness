"""Real cost ledger and normal-budget observability through headed Chrome."""
import json
import math
from pathlib import Path
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

LEDGER = Path(__file__).resolve().parents[1] / '.pih-agent/production-audit-cost-meter.json'

def snapshot(audit, panel_id):
    return next(x['data'] for x in audit.page.request.get(BASE + '/api/plugin-ui').json()['items'] if x['id'] == panel_id)

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['cost-meter', 'fail-logger', 'token-guard'])
    try:
        first_id = audit.page.request.get(BASE + '/api/session').json()['sessionId']
        initial = snapshot(audit, 'token-guard-panel')
        assert initial['maxRunTokens'] == 1000000 and initial['aborts'] == 0 and initial['lastError'] is None
        audit.panel('Token Guard', ['上下文预算', '本次运行已报告用量'])
        errors_before = snapshot(audit, 'fail-logger-panel')['observed']
        result = audit.invoke('cost_report', {'refresh': True}, allow_writes=True)
        assert not result['isError']
        report = result['details']
        assert report['budget'] == 1 and report['dayBasis'] == 'UTC' and report['lastError'] is None
        assert all(math.isfinite(report[k]) and report[k] >= 0 for k in ['sessionCost', 'todayCost', 'lifetimeCost'])
        model_text = '\n'.join(x['text'] for x in result['content'] if x['type'] == 'text')
        print('model_visible_budget', 'budget' in model_text.lower(), flush=True)
        final = snapshot(audit, 'cost-meter-panel')
        disk = json.loads(LEDGER.read_text())
        assert disk['version'] == 2 and LEDGER.stat().st_mode & 0o777 == 0o600
        entry = next(x for x in disk['entries'] if x['sessionId'] == first_id)
        assert entry['messages'] > 0 and entry['tokens'] > 0
        assert math.isclose(entry['sessionCost'], final['sessionCost'], abs_tol=0.000001)
        assert math.isclose(sum(x['cost'] for x in disk['entries']), final['lifetimeCost'], abs_tol=0.000001)
        assert not LEDGER.with_suffix('.json.lock').exists()
        guard = snapshot(audit, 'token-guard-panel')
        assert guard['runTokens'] > 0 and guard['aborts'] == 0 and not guard['exceeded'] and guard['lastError'] is None
        assert snapshot(audit, 'fail-logger-panel')['observed'] == errors_before
        audit.panel('Cost Meter', ['今日（UTC）', '每日预算（UTC）', 'UTC 日账本'])
        audit.panel('Failure Logger', ['聚合后的失败记录'])
        audit.new_session()
        second_id = audit.page.request.get(BASE + '/api/session').json()['sessionId']
        assert second_id != first_id
        fresh = snapshot(audit, 'cost-meter-panel')
        assert fresh['sessionCost'] == 0 and fresh['lifetimeCost'] == final['lifetimeCost']
        assert any(x['sessionId'] == first_id for x in fresh['entries'])
        guard = snapshot(audit, 'token-guard-panel')
        assert guard['runTokens'] is None and guard['aborts'] == 0 and guard['lastError'] is None
        result = audit.invoke('cost_report', {'refresh': False})
        assert not result['isError']
        assert any(x['sessionId'] == first_id for x in result['details']['entries'])
        audit.finish()
        print('normal_budget_and_cost_persistence PASS', flush=True)
        assert 'budget' in model_text.lower(), 'cost_report omits configured budget from model-visible content'
        summary = json.loads(model_text)
        assert all(summary[k] == report[k] for k in report if k != 'entries')
        assert summary['entryCount'] == len(report['entries']) and 'entries' not in summary
        assert 'not a provider invoice' in summary['scope'] and 'does not stop runs' in summary['scope']
    finally:
        audit.close()
