"""Actual-model search of an owned native journal with emoji clipping boundaries."""
import hashlib
import json
import re
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

ROOT = Path(__file__).resolve().parent.parent
DIRECTORY = ROOT / '.pih-agent/sessions'
query = 'u:' + uuid4().hex  # 34 UTF-16 units puts both old clipping bounds inside emoji.
with tempfile.TemporaryDirectory(prefix='pih-search-unicode-') as temporary, sync_playwright() as p:
    workspace = str(Path(temporary).resolve())
    fixture = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', '''
import {SessionManager} from '@earendil-works/pi-coding-agent';
const [cwd,directory,query]=process.argv.slice(1);
const manager=SessionManager.create(cwd,directory);
manager.appendMessage({role:'user',content:'😀'.repeat(350)+query+'😀'.repeat(350),timestamp:Date.now()});
manager.appendMessage({role:'assistant',content:[{type:'text',text:'Synthetic preview fixture.'}],api:'openai-completions',provider:'fixture',model:'fixture',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()});
manager.appendSessionInfo('Owned Unicode preview fixture');
process.stdout.write(JSON.stringify({path:manager.getSessionFile(),id:manager.getSessionId()}));
''', workspace, str(DIRECTORY), query], cwd=ROOT, text=True))
    target = Path(fixture['path'])
    assert target.parent == DIRECTORY and target.is_file()
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    audit = LivePluginBrowser(p, ['session-search'], new_session=False, wait_until='domcontentloaded')
    original = audit.page.request.get(BASE + '/api/session').json()
    assert original.get('sessionFile')
    try:
        assert audit.page.request.post(BASE + '/api/session/new', data={'cwd': workspace}).ok
        audit.page.goto(BASE, wait_until='domcontentloaded')
        cursor = None
        found = False
        for _ in range(10):
            params = {'query': query}
            if cursor is not None:
                params['cursor'] = cursor
            result = audit.invoke('session_search', params)
            assert not result['isError']
            report = result['details']
            assert json.loads(result['content'][0]['text']) == report
            matches = [item for item in report['items'] if item['id'] == fixture['id']]
            if matches:
                preview = matches[0]['hits'][0]['text']
                assert query in preview and '�' not in preview
                assert len(preview.encode('utf-16-le')) // 2 <= 500
                preview.encode('utf-8', errors='strict')
                assert preview.startswith('😀') and preview.endswith('😀')
                audit.panel('Session Search', [preview])
                audit.page.get_by_role('button', name=re.compile(r'^插件，已安装')).click()
                audit.page.get_by_role('button', name='查看 Session Search 详情', exact=True).click()
                card = audit.page.locator('.plugin-panel-card').filter(has_text='Session Search')
                assert card.get_by_text(preview, exact=True).evaluate('''el => el.scrollHeight<=el.clientHeight+1 || ['auto','scroll'].includes(getComputedStyle(el).overflowY)'''), 'Actual preview is clipped without scroll access'
                assert card.evaluate('''el => {
                  for(let node=el;node;node=node.parentElement)
                    if(node.scrollWidth>node.clientWidth+1)return false;
                  return true;
                }'''), 'Actual search result overflowed its panel'
                found = True
                break
            cursor = report['nextCursor']
            assert cursor is not None, 'Owned journal was not found'
        assert found
        assert hashlib.sha256(target.read_bytes()).hexdigest() == digest
        audit.finish()
        print('actual_model_unicode_search_preview_and_unchanged_journal PASS', flush=True)
    finally:
        try:
            assert audit.page.request.post(BASE + '/api/session/open', data={'path': original['sessionFile']}).ok
            audit.page.goto(BASE, wait_until='domcontentloaded')
            assert audit.page.request.get(BASE + '/api/session').json()['sessionId'] == original['sessionId']
            print('original_session_restored PASS', flush=True)
        finally:
            audit.close()
            target.unlink()
