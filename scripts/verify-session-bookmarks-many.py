"""Actual-model list and headed access to 25 native bookmarks; no response injection."""
import json
import re
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser

ROOT = Path(__file__).resolve().parent.parent
DIRECTORY = ROOT / '.pih-agent/sessions'
with sync_playwright() as p:
    fixture = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', '''
import {SessionManager} from '@earendil-works/pi-coding-agent';
const [cwd,directory]=process.argv.slice(1);
const manager=SessionManager.create(cwd,directory);
const bookmarks=[];
for(let index=1;index<=25;index++) {
  const id=manager.appendMessage({role:'user',content:`Owned bookmark fixture entry ${index}`,timestamp:Date.now()});
  const label=`Owned bookmark ${index}`;
  manager.appendLabelChange(id,label);
  bookmarks.push({id,entryId:id,label});
}
manager.appendMessage({role:'assistant',content:[{type:'text',text:'Synthetic bookmark fixture ready.'}],api:'openai-completions',provider:'fixture',model:'fixture',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()});
manager.appendSessionInfo('Owned 25 bookmark fixture');
process.stdout.write(JSON.stringify({path:manager.getSessionFile(),id:manager.getSessionId(),bookmarks}));
''', str(ROOT), str(DIRECTORY)], cwd=ROOT, text=True))
    target = Path(fixture['path'])
    assert target.parent == DIRECTORY and target.is_file()
    audit = LivePluginBrowser(p, ['session-bookmarks'], new_session=False, wait_until='domcontentloaded')
    original = audit.page.request.get(BASE + '/api/session').json()
    try:
        response = audit.page.request.post(BASE + '/api/session/open', data={'path': str(target)})
        assert response.ok and response.json()['sessionId'] == fixture['id'], f'Owned fixture open failed: {response.status} {response.text()[:500]}'
        audit.page.goto(BASE, wait_until='domcontentloaded')
        result = audit.invoke('session_bookmarks', {'action': 'list'})
        assert not result['isError'] and result['details']['bookmarks'] == fixture['bookmarks']
        for width in [1440, 760]:
            audit.page.set_viewport_size({'width': width, 'height': 960})
            audit.page.goto(BASE, wait_until='domcontentloaded')
            audit.page.get_by_role('button', name=re.compile(r'^插件，已安装')).click()
            audit.page.get_by_role('button', name='查看 Session Bookmarks 详情', exact=True).click()
            card = audit.page.locator('.plugin-panel-card').filter(has_text='Session Bookmarks')
            expect(card.get_by_text('25 个书签', exact=True)).to_be_visible()
            for bookmark in fixture['bookmarks']:
                label = card.get_by_text(bookmark['label'], exact=True)
                expect(label).to_have_count(1)
                label.scroll_into_view_if_needed()
                expect(label).to_be_in_viewport()
            audit.page.screenshot(path=f'/tmp/pih-session-bookmarks-many-{width}.png')
            print('all_25_native_bookmarks_accessible PASS', width, flush=True)
        audit.finish()
    finally:
        try:
            response = audit.page.request.post(BASE + '/api/session/open', data={'path': original['sessionFile']})
            assert response.ok and response.json()['sessionId'] == original['sessionId']
            audit.page.goto(BASE, wait_until='domcontentloaded')
        finally:
            audit.close()
            target.unlink()
