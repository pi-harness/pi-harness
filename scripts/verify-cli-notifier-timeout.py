"""Compiled notifier with a real controlled command; injected failure-panel rendering."""
import argparse
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

parser = argparse.ArgumentParser()
parser.add_argument('--tree', action='store_true')
options = parser.parse_args()
ROOT = Path(__file__).resolve().parent.parent
panel = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', r'''
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter,join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {PiToolRegistry,PiPluginUiRegistry} from '@pi-harness/plugin-api';
import plugin from './packages/plugins/cli-notifier/dist/index.js';
assert.ok(process.platform==='darwin'||process.platform==='linux');
const root=await mkdtemp(join(tmpdir(),'pih-notifier-timeout-'));
const executable=join(root,process.platform==='darwin'?'osascript':'notify-send');
const marker=join(root,'called'),ready=join(root,'ready');
const context=new Context(),tools=new PiToolRegistry(),panels=new PiPluginUiRegistry();
const originalPath=process.env.PATH;
const tree=process.argv[1]==='--tree';
let pid;
try {
  const worker='process.on("SIGTERM",()=>{'+(tree?'':'process.exit(0)')+'});require("node:fs").writeFileSync('+JSON.stringify(ready)+',String(process.pid));setTimeout(()=>process.exit(9),8000)';
  const action=tree?'require("node:child_process").spawn(process.execPath,["-e",'+JSON.stringify(worker)+'],{stdio:"ignore"})':worker;
  await writeFile(executable,'#!'+process.execPath+'\nconst fs=require("node:fs");if(fs.existsSync('+JSON.stringify(marker)+'))process.exit(0);fs.writeFileSync('+JSON.stringify(marker)+',"");'+action+'\n');
  await chmod(executable,0o700);
  process.env.PATH=root+delimiter+(originalPath??'');
  context.provide('piTools',tools);context.provide('piPluginUi',panels);
  await context.plugin(plugin,{enabled:true,timeoutMs:2000});
  const tool=tools.snapshot().customTools.find(x=>x.name==='cli_notify');
  const result=await tool.execute('timeout',{message:'Synthetic timed-out notification'},undefined,undefined,{});
  assert.equal(result.details.delivered,false);
  assert.equal(result.details.reason,'Notification command timed out after 2000 ms');
  assert.match(result.content[0].text,/not submitted/);
  pid=Number(await readFile(ready,'utf8'));
  assert.ok(Number.isSafeInteger(pid)&&pid>0);
  const deadline=Date.now()+3000;
  for (;;) {
    try {process.kill(pid,0);} catch(error) {if(error.code==='ESRCH')break;throw error;}
    assert.ok(Date.now()<deadline,'Timed-out worker survived');
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  const [panel]=await panels.snapshot();
  const recovery=await tool.execute('recovery',{message:'Synthetic queue recovery'},undefined,undefined,{});
  assert.equal(recovery.details.delivered,true);
  process.stdout.write(JSON.stringify(panel));
} finally {
  process.env.PATH=originalPath;
  await context.fiber.dispose();
  if(Number.isSafeInteger(pid)&&pid>0) {try {process.kill(pid,'SIGKILL');} catch {}}
  await rm(root,{recursive:true,force:true});
}
''', '--', '--tree' if options.tree else '--zero'], cwd=ROOT, text=True))

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['cli-notifier'], new_session=False, wait_until='domcontentloaded')
    try:
        snapshot = audit.page.request.get(BASE + '/api/plugin-ui').json()
        snapshot['items'] = [panel if item['id'] == panel['id'] else item for item in snapshot['items']]
        audit.page.route('**/api/plugin-ui', lambda route: route.fulfill(json=snapshot))
        audit.page.goto(BASE, wait_until='domcontentloaded')
        audit.panel('CLI Notifier', ['未提交系统', 'Synthetic timed-out notification', 'Notification command timed out after 2000 ms'])
        audit.finish()
        print('compiled_notifier_timeout_cleanup_queue_and_injected_panel PASS', {'tree': options.tree}, flush=True)
    finally:
        audit.close()
