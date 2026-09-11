"""Real-model recall of synthetic unanswered sessions, with exact source identity."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser

parser = argparse.ArgumentParser()
parser.add_argument('--baseline', action='store_true', help='Observe old model-visible fields without requiring the fix')
parser.add_argument('--scan-limit', type=int, default=2, help='Expected configured runtime scan limit')
args = parser.parse_args()
WORKTREE = Path('/Volumes/librefang/worktrees/plugin-functional-verification')
fixture = json.loads(subprocess.check_output(
    ['node', 'scripts/fixtures/plugin-verification/recall-unread.mjs'], cwd=WORKTREE, text=True,
))

def digests():
    return {item['id']: hashlib.sha256(Path(item['path']).read_bytes()).hexdigest() for item in fixture['items']}

before = digests()
try:
    with sync_playwright() as p:
        audit = LivePluginBrowser(p, ['recall-unread'])
        try:
            result = audit.invoke('session_recall_unread', {'query': fixture['marker']})
            assert not result['isError']
            details = result['details']
            assert [item['id'] for item in details['items']] == [item['id'] for item in fixture['items']]
            assert details['total'] == 2
            inventory = details['inventory']
            assert inventory['scanned'] == min(inventory['candidates'], args.scan_limit)
            assert inventory['scanTruncated'] == (inventory['candidates'] > args.scan_limit)
            text = result['content'][0]['text']
            fields = {'ids': all(item['id'] in text for item in fixture['items']),
                      'paths': all(item['path'] in text for item in fixture['items']),
                      'inventory': 'scanTruncated' in text}
            print('recall_model_fields', fields, flush=True)
            audit.panel('Recall Unread', [fixture['items'][0]['name'], fixture['items'][0]['message']])
            audit.page.get_by_role('button', name='插件，已安装', exact=False).click()
            audit.page.get_by_role('button', name='查看 Recall Unread 详情', exact=True).click()
            expect(audit.page.get_by_text('读取会话内容', exact=True)).to_be_visible(timeout=15000)
            expect(audit.page.get_by_text('读取本机文件', exact=True)).to_be_visible()
            card = audit.page.locator('.plugin-panel-card').filter(has_text='Recall Unread')
            layout = card.evaluate('node => ({width:node.clientWidth, scroll:node.scrollWidth})')
            audit.page.screenshot(path='/tmp/pih-recall-unread-layout.png')
            print('recall_layout', layout, flush=True)
            assert layout['scroll'] <= layout['width'] + 1, 'Unread previews overflow their panel'
            if not args.baseline:
                assert json.loads(text) == details
                assert all(fields.values())
                assert details['nextOffset'] is None and details['returned'] == 2
                for offset in range(2):
                    page = audit.invoke('session_recall_unread', {'query': fixture['marker'], 'offset': offset, 'limit': 1})
                    assert not page['isError']
                    payload = json.loads(page['content'][0]['text'])
                    assert payload == page['details'] and payload['offset'] == offset
                    assert payload['total'] == 2 and payload['returned'] == 1
                    assert payload['items'][0]['id'] == fixture['items'][offset]['id']
                    assert payload['nextOffset'] == (1 if offset == 0 else None)
                    assert len(page['content'][0]['text'].encode()) <= 128 * 1024
                empty = audit.invoke('session_recall_unread', {'query': fixture['marker'] + '_no_match'})
                assert not empty['isError']
                assert json.loads(empty['content'][0]['text']) == empty['details']
                assert empty['details']['total'] == 0 and empty['details']['items'] == []
                assert empty['details']['nextOffset'] is None
                # Filtering a tool page must not replace the full cached panel inventory.
                audit.panel('Recall Unread', [fixture['items'][0]['name'], fixture['items'][0]['message']])
                invalid = audit.invoke('session_recall_unread', {'limit': 0})
                assert invalid['isError']
                panels = audit.page.request.get(BASE + '/api/plugin-ui', max_retries=2).json()['items']
                data = next(item['data'] for item in panels if item['id'] == 'recall-unread-panel')
                assert all(item['id'] in {row['id'] for row in data['items']} for item in fixture['items'])
                audit.new_session()
                audit.panel('Recall Unread', ['当前会话尚未扫描，请运行 session_recall_unread。'])
                panels = audit.page.request.get(BASE + '/api/plugin-ui', max_retries=2).json()['items']
                data = next(item['data'] for item in panels if item['id'] == 'recall-unread-panel')
                assert data['status']['state'] == 'idle' and data['total'] == 0 and data['items'] == []
            assert digests() == before
            audit.finish()
            print('recall_baseline OBSERVED' if args.baseline else 'recall_unread PASS', flush=True)
        finally:
            audit.close()
finally:
    for item in fixture['items']:
        Path(item['path']).unlink()
