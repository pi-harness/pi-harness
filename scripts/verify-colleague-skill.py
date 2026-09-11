"""Real model/native-journal handoff persistence and complete visible packet."""
import json
from pathlib import Path

from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

ROOT = Path(__file__).resolve().parent.parent

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['colleague-skill'], new_session=False, wait_until='domcontentloaded')
    original = audit.page.request.get(BASE + '/api/session').json()
    assert original.get('sessionFile')

    def latest():
        return next(x['data']['latest'] for x in audit.page.request.get(BASE + '/api/plugin-ui').json()['items']
                    if x['id'] == 'colleague-skill-panel')

    try:
        assert audit.page.request.post(BASE + '/api/session/new', data={'cwd': str(ROOT)}).ok
        audit.page.goto(BASE, wait_until='domcontentloaded')
        assert latest() is None
        params = {
            'toRole': '审阅员', 'objective': audit.marker + ' 合成交接验收 😀',
            'context': '仅记录合成数据；不要启动代理、读取文件或发送消息。',
            'constraints': [f'CONSTRAINT_{i:02d}_保持合成数据' for i in range(1, 21)],
            'files': [f'fixture/目录/file-{i:02d}.ts' for i in range(1, 21)],
            'acceptance': [f'ACCEPTANCE_{i:02d}_内容完整' for i in range(1, 21)],
        }
        params['files'][10] = params['files'][0]  # Valid repeated reference must not break React keys.
        params['files'][-1] = 'very-long-directory/' * 20 + 'FINAL_FILE_20.ts'
        try:
            result = audit.invoke('colleague_handoff', params, allow_writes=True)
        except AssertionError:
            calls = [part for message in audit.messages() for part in message.get('content', [])
                     if isinstance(part, dict) and part.get('type') == 'toolCall'
                     and part.get('name') == 'colleague_handoff']
            if calls:
                actual = calls[-1]['arguments']
                print('synthetic_parameter_differences', {
                    key: {'expected': params.get(key), 'actual': actual.get(key)}
                    for key in params.keys() | actual.keys() if params.get(key) != actual.get(key)
                }, flush=True)
            raise
        assert not result['isError']
        packet = result['details']
        assert {key: packet[key] for key in params} == params
        assert packet['id'] and packet['createdAt']
        assert packet['id'] in result['content'][0]['text']
        session = audit.page.request.get(BASE + '/api/session').json()
        entries = [json.loads(line) for line in Path(session['sessionFile']).read_text().splitlines() if line]
        packets = [entry['data'] for entry in entries if entry.get('type') == 'custom'
                   and entry.get('customType') == 'pi-harness/colleague-handoff']
        assert packets == [packet]
        assert latest() == packet
        audit.page.reload(wait_until='domcontentloaded')
        assert latest() == packet

        assert audit.page.request.post(BASE + '/api/session/new', data={'cwd': str(ROOT)}).ok
        audit.page.goto(BASE, wait_until='domcontentloaded')
        assert latest() is None
        assert audit.page.request.post(BASE + '/api/session/open', data={'path': session['sessionFile']}).ok
        audit.page.goto(BASE, wait_until='domcontentloaded')
        assert audit.page.request.get(BASE + '/api/session').json()['sessionId'] == session['sessionId']
        assert latest() == packet
        print('handoff_native_journal_reload_session_isolation_reopen PASS', flush=True)
        audit.panel('Colleague Skill', [params['objective'], '• ' + params['constraints'][-1],
                                      '• ' + params['acceptance'][-1], params['files'][-1]])
        file_node = audit.page.locator('code').filter(has_text='FINAL_FILE_20.ts')
        # Reopen detail because panel() returns to the session page.
        audit.page.get_by_role('button', name='插件，已安装', exact=False).click()
        audit.page.get_by_role('button', name='查看 Colleague Skill 详情', exact=True).click()
        card = audit.page.locator('.plugin-panel-card')
        assert card.locator('code').all_text_contents() == params['files']
        assert card.locator('li').all_text_contents() == [
            '• ' + text for text in params['constraints'] + params['acceptance']
        ]
        assert file_node.evaluate('(node) => node.scrollWidth <= node.clientWidth + 1 && getComputedStyle(node).textOverflow !== "ellipsis"')
        assert audit.page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        audit.finish()
        print('colleague_full_twenty_item_packet_visible PASS', flush=True)
    finally:
        try:
            assert audit.page.request.post(BASE + '/api/session/open', data={'path': original['sessionFile']}).ok
            audit.page.goto(BASE, wait_until='domcontentloaded')
            assert audit.page.request.get(BASE + '/api/session').json()['sessionId'] == original['sessionId']
            print('original_session_restored PASS', flush=True)
        finally:
            audit.close()
