"""Observe a real queued native switch; read receipts from its original test journal."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser, wait_for_async_condition

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['tab-manager'])
    try:
        pinned = audit.invoke('session_tab_manage', {'action': 'pin', 'label': audit.marker + '_TARGET'}, allow_writes=True)
        assert not pinned['isError']
        target = pinned['details']['sessionPath']
        audit.new_session()
        source = Path(audit.page.request.get(BASE + '/api/session').json()['sessionFile'])
        assert str(source) != target
        params = {'action': 'activate', 'sessionPath': target}
        audit.page.get_by_role('textbox', name='Prompt', exact=True).fill(
            f'{audit.marker} Call session_tab_manage exactly once with {json.dumps(params)}. '
            'This switches only the synthetic audit session after this turn. Do not call other tools. '
            'Preserve all arguments exactly. Reply only DONE after the result, without retries.'
        )
        with audit.page.expect_response(lambda response: response.url.endswith('/api/prompt'), timeout=180000) as pending:
            audit.page.get_by_role('button', name='发送消息', exact=True).click()
        assert pending.value.ok
        entries = [json.loads(line) for line in source.read_text().splitlines()]
        messages = [entry['message'] for entry in entries if entry.get('type') == 'message']
        calls = [part for message in messages for part in message.get('content', [])
                 if isinstance(part, dict) and part.get('type') == 'toolCall']
        assert len(calls) == 1 and calls[0]['name'] == 'session_tab_manage' and calls[0]['arguments'] == params
        results = [message for message in messages if message.get('role') == 'toolResult']
        assert len(results) == 1 and not results[0]['isError']
        receipt = results[0]['details']
        assert receipt['state'] == 'waiting' and receipt['sessionPath'] == target
        wait_for_async_condition(audit.page, '''async target => {
          const response = await fetch('/api/plugin-ui');
          if (!response.ok) return false;
          const panel = (await response.json()).items.find(item => item.id === 'tab-manager-panel');
          return panel?.data.activation?.state === 'completed' && panel.data.currentSessionPath === target;
        }''', arg=target, timeout=30000)
        assert audit.page.request.get(BASE + '/api/session').json()['sessionFile'] == target
        expect(audit.page.locator('button.session-row.active').filter(has_text=audit.marker).filter(has_text='插件验证')).to_have_count(1)
        print('activation_url_matches_runtime', audit.page.evaluate('(target) => new URL(location.href).searchParams.get("session") === target', target), flush=True)
        audit.panel('Session Tabs', ['会话切换完成', audit.marker + '_TARGET'])
        removed = audit.invoke('session_tab_manage', {'action': 'remove', 'sessionPath': target}, allow_writes=True)
        assert not removed['isError']
        assert all(tab['sessionPath'] != target for tab in removed['details']['tabs'])
        assert Path(target).is_file() and source.is_file()
        audit.finish()
        print('tab_native_activation PASS', flush=True)
    finally:
        audit.close()
