"""Verify actual extension failures, aggregation and retained state in headed Chrome.

Before starting the isolated source server, mount the explicit-only
scripts/fixtures/plugin-verification/observability/failure-extension.mjs fixture
as an extension in its test agent directory. Remove that mount after testing.
"""
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

def failures(audit):
    return next(x['data'] for x in audit.page.request.get(BASE + '/api/plugin-ui').json()['items'] if x['id'] == 'fail-logger-panel')

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['fail-logger', 'cost-meter'])
    try:
        before = failures(audit)
        audit.marker = 'PIH_FAIL_LOGGER_AUDIT_' + audit.marker
        for count in [1, 2]:
            result = audit.invoke('cost_report', {'refresh': False})
            assert not result['isError'], 'diagnostic extension failure broke the normal tool run'
            current = failures(audit)
            assert current['observed'] == before['observed'] + count
            matching = [f for f in current['failures'] if 'PIH_EXPECTED_EXTENSION_FAILURE' in f['message']]
            assert len(matching) == 1 and matching[0]['source'] == 'extension' and matching[0]['occurrences'] == count
        audit.panel('Failure Logger', ['聚合后的失败记录', '×2'])
        audit.new_session()
        assert failures(audit) == current, 'global diagnostic history lost on session navigation'
        audit.finish()
        print('real_extension_errors_aggregated_and_retained PASS', flush=True)
    finally:
        audit.close()
