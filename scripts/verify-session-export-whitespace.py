"""Actual-model export of native text with significant whitespace."""
import json
import re
from pathlib import Path
import subprocess
from uuid import uuid4
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser

ROOT = Path(__file__).resolve().parent.parent
DIRECTORY = ROOT / '.pih-agent/sessions'
relative = '.pi-harness/production-auth/exports/whitespace-' + uuid4().hex + '.md'
output = ROOT / relative
user_text = '    if ready:\n        run()\n\n'
parts = ['first line  ', 'second line\n\n', '    code()\n']
with sync_playwright() as p:
    fixture = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', '''
import {SessionManager} from '@earendil-works/pi-coding-agent';
const [cwd,directory,user,parts]=process.argv.slice(1);
const manager=SessionManager.create(cwd,directory);
manager.appendMessage({role:'user',content:user,timestamp:Date.now()});
manager.appendMessage({role:'assistant',content:JSON.parse(parts).map(text=>({type:'text',text})),api:'openai-completions',provider:'fixture',model:'fixture',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()});
manager.appendSessionInfo('Owned export whitespace fixture');
process.stdout.write(JSON.stringify({path:manager.getSessionFile(),id:manager.getSessionId()}));
''', str(ROOT), str(DIRECTORY), user_text, json.dumps(parts)], cwd=ROOT, text=True))
    target = Path(fixture['path'])
    assert target.parent == DIRECTORY and target.is_file() and not output.exists()
    audit = LivePluginBrowser(p, ['session-export'], new_session=False, wait_until='domcontentloaded')
    original = audit.page.request.get(BASE + '/api/session').json()
    try:
        response = audit.page.request.post(BASE + '/api/session/open', data={'path': str(target)})
        assert response.ok and response.json()['sessionId'] == fixture['id']
        audit.page.goto(BASE, wait_until='domcontentloaded')
        before = audit.messages()[:2]
        result = audit.invoke('session_export', {'path': relative, 'confirm': False}, allow_writes=True)
        assert not result['isError']
        content = output.read_text()
        assert '## User\n\n' + user_text + '\n\n## Assistant\n\n' + '\n'.join(parts) in content
        assert output.stat().st_mode & 0o777 == 0o600
        assert len(output.read_bytes()) == result['details']['bytes']
        assert audit.messages()[:2] == before, 'Export changed original messages'
        parsed = subprocess.check_output(['node', '--input-type=module', '-e', '''
import {readFileSync} from 'node:fs';
import {marked} from 'marked';
const html=marked.parse(readFileSync(process.argv[1],'utf8'));
if(!html.includes('<pre><code>if ready:\\n    run()\\n</code></pre>') || !html.includes('first line<br>'))process.exit(1);
process.stdout.write('markdown_code_and_hard_break_preserved PASS');
''', str(output)], cwd=ROOT, text=True)
        print(parsed, flush=True)
        audit.panel('Session Export', [relative, str(ROOT)])
        for width in [1440, 960, 760]:
            audit.page.set_viewport_size({'width': width, 'height': 960})
            audit.page.goto(BASE, wait_until='domcontentloaded')
            audit.page.get_by_role('button', name=re.compile(r'^插件，已安装')).click()
            audit.page.get_by_role('button', name='查看 Session Export 详情', exact=True).click()
            card = audit.page.locator('.plugin-panel-card').filter(has_text='Session Export')
            path = card.get_by_text(relative, exact=True)
            expect(path).to_be_visible()
            path.scroll_into_view_if_needed()
            audit.page.screenshot(path=f'/tmp/pih-session-export-path-{width}.png')
            violations = card.evaluate('''el => {
                const right=el.getBoundingClientRect().right, errors=[];
                for(const node of el.querySelectorAll('div,code,dd'))
                    if(node.getBoundingClientRect().right>right+1) errors.push(node.tagName);
                for(let node=el;node;node=node.parentElement)
                    if(node.scrollWidth>node.clientWidth+1) errors.push('ancestor overflow');
                return errors;
            }''')
            assert not violations, f'Export path layout overflows at {width}: {violations}'
            assert path.evaluate('el => el.scrollWidth<=el.clientWidth+1 && el.scrollHeight<=el.clientHeight+1'), f'Export path is clipped at {width}'
            print('export_path_readable PASS', width, flush=True)
        audit.finish()
        print('actual_model_export_whitespace_and_unchanged_messages PASS', flush=True)
    finally:
        try:
            response = audit.page.request.post(BASE + '/api/session/open', data={'path': original['sessionFile']})
            assert response.ok and response.json()['sessionId'] == original['sessionId']
            audit.page.goto(BASE, wait_until='domcontentloaded')
        finally:
            audit.close()
            target.unlink()
            if output.exists():
                output.unlink()
