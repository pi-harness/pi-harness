"""Verify real local service events, observation, caps, and historical panel state."""
import json
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

disclaimer = '最多保留 100 个事件名，界面显示前 8 个；事件名已截断。不读取或保存事件属性。此服务不拦截网络，也不阻止其他事件监听器。'

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['telemetry-blocker'])
    try:
        initial = audit.invoke('telemetry_status', {})
        assert not initial['isError'] and initial['details']['discarded'] == 0 and initial['details']['observed'] == 0
        audit.panel('Telemetry Blocker', ['尚未收到遥测事件。', '丢弃本地 piTelemetry 服务调用并统计事件总线观察；不保存事件属性，不拦截网络流量，也不阻止其他监听器。', '本地遥测服务', '事件总线观察'])
        generated = audit.invoke('verify_telemetry_events', {})
        assert not generated['isError']
        report = generated['details']
        assert report['otherListener'] == 1 and report['invalidRejected']
        expected = report['snapshot']
        assert expected['enabled'] is False and expected['discarded'] == 105 and expected['observed'] == 1
        assert expected['names'] == [f'AUDIT_EVENT_{index}' for index in range(100)]
        assert expected['namesTruncated'] is True
        assert 'AUDIT_PROPERTIES_NOT_RETAINED' not in json.dumps(expected)
        status = audit.invoke('telemetry_status', {})
        assert not status['isError'] and status['details'] == expected
        assert json.loads(status['content'][0]['text']) == expected
        audit.panel('Telemetry Blocker', ['丢弃 105 次 · 总线观察 1 次', disclaimer])
        audit.new_session()
        later = audit.invoke('telemetry_status', {})
        assert not later['isError'] and later['details'] == expected
        audit.panel('Telemetry Blocker', ['丢弃 105 次 · 总线观察 1 次', disclaimer])
        audit.finish()
        print('telemetry_blocker PASS', flush=True)
    finally:
        audit.close()
