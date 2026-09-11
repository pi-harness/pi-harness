"""Exercise real handoff tools and native queued delivery in visible Chrome."""
import hashlib
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser


def bridge_entries(path):
    return [entry for line in path.read_text().splitlines()
            if (entry := json.loads(line)).get('type') == 'custom_message'
            and entry.get('customType') == 'pi-harness/session-bridge']


with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['session-bridge'])
    try:
        exported = audit.invoke('session_bridge_export', {})
        assert not exported['isError']
        package = exported['details']
        assert json.loads(exported['content'][0]['text']) == package
        assert package['version'] == 1 and package['messageCount'] == len(package['messages'])
        assert any(audit.marker in item['text'] for item in package['messages'])
        assert not package['unresolvedAttachments']
        package_text = json.dumps(package, ensure_ascii=False, separators=(',', ':'))
        assert len(package_text.encode()) <= 256 * 1024
        audit.panel('Session Bridge', ['最近导出', '格式 v1', '最多 100 条消息'])
        audit.page.get_by_role('button', name='插件，已安装', exact=False).click()
        audit.page.get_by_role('button', name='查看 Session Bridge 详情', exact=True).click()
        expect(audit.page.get_by_text('写入本机文件', exact=True)).to_be_visible()
        expect(audit.page.get_by_text('只读运行', exact=True)).not_to_be_visible()
        preview = audit.invoke('session_bridge_preview', {'package': package_text})
        assert not preview['isError']
        assert json.loads(preview['content'][0]['text']) == preview['details']
        assert preview['details']['source'] == package['source']
        assert set(preview['details']['preview']) == {'goal', 'currentState', 'decisions', 'keyFiles', 'nextStep'}
        audit.panel('Session Bridge', [preview['details']['preview']['goal']])
        source = Path(audit.page.request.get(BASE + '/api/session', max_retries=2).json()['sessionFile'])
        source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        audit.new_session()
        target = Path(audit.page.request.get(BASE + '/api/session', max_retries=2).json()['sessionFile'])
        assert target != source
        refused = audit.invoke('session_bridge_import', {'package': package_text, 'confirm': False}, allow_writes=True)
        assert refused['isError'] and 'confirm=true' in refused['content'][0]['text']
        assert not bridge_entries(target)
        audit.panel('Session Bridge', ['原因：Session Bridge import requires confirm=true'])
        imported = audit.invoke('session_bridge_import', {'package': package_text, 'confirm': True}, allow_writes=True)
        assert not imported['isError']
        assert imported['details']['accepted'] and imported['details']['delivery'] == 'queued'
        assert imported['details']['source'] == package['source']
        entries = bridge_entries(target)
        assert len(entries) == 1 and audit.marker in entries[0]['content']
        assert entries[0]['details']['source'] == package['source']
        assert any(m.get('customType') == 'pi-harness/session-bridge' for m in audit.messages())
        audit.panel('Session Bridge', ['最近导入请求'])
        duplicate = audit.invoke('session_bridge_import', {'package': package_text, 'confirm': True}, allow_writes=True)
        assert duplicate['isError'] and 'already imported or queued' in duplicate['content'][0]['text']
        assert bridge_entries(target) == entries
        malformed = audit.invoke('session_bridge_preview', {'package': '{}'})
        assert malformed['isError']
        panels = audit.page.request.get(BASE + '/api/plugin-ui', max_retries=2).json()['items']
        status = next(panel['data']['status'] for panel in panels if panel['id'] == 'session-bridge-panel')
        assert status['state'] == 'failed' and status['operation'] == 'preview'
        audit.panel('Session Bridge', ['原因：' + status['error'], '最近导入请求'])
        assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
        audit.new_session()
        audit.page.get_by_role('button', name='插件，已安装', exact=False).click()
        audit.page.get_by_role('button', name='查看 Session Bridge 详情', exact=True).click()
        expect(audit.page.get_by_text('最近导入请求', exact=True)).not_to_be_visible()
        expect(audit.page.get_by_text('原因：' + status['error'], exact=True)).not_to_be_visible()
        reset_panels = audit.page.request.get(BASE + '/api/plugin-ui', max_retries=2).json()['items']
        reset = next(panel['data'] for panel in reset_panels if panel['id'] == 'session-bridge-panel')
        assert reset['status']['state'] == 'idle' and reset['latest'] is None and reset['latestPreview'] is None
        audit.page.screenshot(path='/tmp/pih-session-bridge-reset.png')
        audit.finish()
        print('session_bridge PASS', flush=True)
    finally:
        audit.close()
