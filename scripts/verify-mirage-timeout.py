"""Real isolated compiled plugin/process timeout, injected panel rendering only."""
import json
import argparse
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--tree', action='store_true', help='Use a SIGTERM-ignoring worker that outlives its CLI parent')
options = parser.parse_args()
panel = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', '''
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {PiToolRegistry,PiPluginUiRegistry} from '@pi-harness/plugin-api';
import plugin from './packages/plugins/mirage-bridge/dist/index.js';
const root=await mkdtemp(join(tmpdir(),'pih-mirage-timeout-'));
const executable=join(root,'mirage.mjs');
const context=new Context(), tools=new PiToolRegistry(), panels=new PiPluginUiRegistry();
const tree=process.argv[1]==='--tree';
async function assertWorkerGone() {
  if (!tree) return;
  const pid=Number(await readFile(join(root,'worker'),'utf8'));
  assert.ok(Number.isSafeInteger(pid)&&pid>0);
  // The call can reject at leader close, before the one-second group escalation.
  // Allow that grace plus scheduling; the worker's 8s watchdog cannot pass this.
  const deadline=Date.now()+3000;
  for (;;) {
    try {process.kill(pid,0);} catch(error) {if(error.code==='ESRCH') return;throw error;}
    assert.ok(Date.now()<deadline,'Timed-out worker survived');
    await new Promise(resolve=>setTimeout(resolve,20));
  }
}
try {
  const worker='process.on("SIGTERM",()=>{});require("node:fs").writeFileSync("worker",String(process.pid));setTimeout(()=>process.exit(9),8000)';
  const script=tree ? 'import {spawn} from "node:child_process";spawn(process.execPath,["-e",'+JSON.stringify(worker)+'],{stdio:"ignore"})' : 'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},100);setTimeout(()=>process.exit(9),5000);';
  await writeFile(executable,'#!/usr/bin/env node\\n'+script+'\\n');
  await chmod(executable,0o700);
  context.provide('piTools',tools);context.provide('piPluginUi',panels);
  context.provide('piHarnessLaunch',{cwd:root,agentDir:root});
  await context.plugin(plugin,{executable,workspaceId:'synthetic',timeoutMs:1000});
  const tool=tools.snapshot().customTools.find(x=>x.name==='mirage_execute');
  const result=await tool.execute('timeout',{command:'inert fixture'},undefined,undefined,{});
  assert.equal(result.details.exitCode,null);
  assert.match(result.content[0].text,/timed out after 1000 ms/);
  await assertWorkerGone();
  const [panel]=await panels.snapshot();
  assert.match(panel.data.lastError,/timed out after 1000 ms/);
  const doctor=tools.snapshot().customTools.find(x=>x.name==='mirage_doctor');
  const check=await doctor.execute('timeout-check',{},undefined,undefined,{});
  assert.equal(check.details.available,false);
  assert.match(check.details.lastError,/check timed out after 1000 ms/);
  await assertWorkerGone();
  process.stdout.write(JSON.stringify(panel));
} finally {await context.fiber.dispose();await rm(root,{recursive:true,force:true});}
''', '--', '--tree' if options.tree else '--direct'], cwd=ROOT, text=True))

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['mirage-bridge'], new_session=False, wait_until='domcontentloaded')
    try:
        snapshot = audit.page.request.get(BASE + '/api/plugin-ui').json()
        snapshot['items'] = [panel if x['id'] == panel['id'] else x for x in snapshot['items']]
        audit.page.route('**/api/plugin-ui', lambda route: route.fulfill(json=snapshot))
        audit.page.reload(wait_until='domcontentloaded')
        audit.panel('Mirage Bridge', ['Mirage command timed out after 1000 ms'])
        audit.page.get_by_role('button', name='插件，已安装', exact=False).click()
        audit.page.get_by_role('button', name='查看 Mirage Bridge 详情', exact=True).click()
        expect(audit.page.locator('.plugin-panel-card').get_by_text('exit —', exact=True)).to_be_visible()
        audit.finish()
        print('actual_process_timeout_and_injected_failure_panel PASS', {'tree': options.tree}, flush=True)
    finally:
        audit.close()
