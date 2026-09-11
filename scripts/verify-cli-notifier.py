"""Real desktop command submission; does not claim OS display/read receipts."""
from pathlib import Path
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser, wait_for_async_condition

ROOT = Path(__file__).resolve().parent.parent

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['cli-notifier'], new_session=False, wait_until='domcontentloaded')
    original = audit.page.request.get(BASE + '/api/session').json()
    try:
        assert original.get('sessionFile') and Path(original['sessionFile']).is_file(), 'Start from a persisted session so it can be restored'
        assert audit.page.request.post(BASE + '/api/session/new', data={'cwd': str(ROOT)}).ok
        audit.page.goto(BASE, wait_until='domcontentloaded')
        params = {'message': audit.marker + ' synthetic notification test', 'title': 'Pi Harness audit'}
        result = audit.invoke('cli_notify', params, allow_writes=True)
        assert not result['isError']
        assert result['details'] == {**params, 'delivered': True, 'platform': 'darwin'}
        assert result['content'] == [{'type': 'text', 'text': 'Desktop notification submitted to the system. Display and read status are not verified.'}]
        wait_for_async_condition(audit.page, '''async message => {
            const {items} = await (await fetch('/api/plugin-ui')).json();
            const entries = items.find(x => x.id === 'cli-notifier-panel').data.notifications;
            const own = entries.findIndex(x => x.message === message);
            return own >= 0 && entries.slice(0, own).some(x => x.message === 'Agent turn completed.');
        }''', arg=params['message'])
        audit.panel('CLI Notifier', ['已提交系统', params['message'], '提交成功不代表通知已显示或已读；请检查系统通知设置。'])
        audit.finish()
        print('real_macos_submission_and_automatic_completion_record PASS; desktop_display NOT_VERIFIED', flush=True)
    finally:
        try:
            if original.get('sessionFile') and Path(original['sessionFile']).is_file():
                restored = audit.page.request.post(BASE + '/api/session/open', data={'path': original['sessionFile']})
                assert restored.ok, f'Session restore HTTP {restored.status}'
                audit.page.goto(BASE, wait_until='domcontentloaded')
                assert audit.page.request.get(BASE + '/api/session').json()['sessionId'] == original['sessionId']
                print('original_session_restored PASS', flush=True)
        finally:
            audit.close()
