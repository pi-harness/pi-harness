"""Real isolated plugin reports rendered in headed Chrome, without a model call."""
import json
import re
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser

ROOT = Path(__file__).resolve().parents[1]
reports = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', '''
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { PiPluginUiRegistry, PiToolRegistry } from '@pi-harness/plugin-api';
import plugin from './packages/plugins/hol-guard/dist/index.js';
const context = new Context();
const tools = new PiToolRegistry(), panels = new PiPluginUiRegistry();
context.provide('piTools', tools);
context.provide('piPluginUi', panels);
await context.plugin(plugin, {});
try {
  const args = {token: 'synthetic-private-marker'};
  args.self = args;
  context.emit('pi/session-event', {type: 'tool_execution_start', toolName: 'fixture', args});
  const review = (await panels.snapshot())[0].data;
  assert.equal(review.latest.risk, 'review');
  assert.equal(review.safe, 0);
  assert.equal(review.latest.findings[0].code, 'scan_unavailable');
  assert.ok(!JSON.stringify(review).includes('synthetic-private-marker'));
  const tool = tools.snapshot().customTools.find(tool => tool.name === 'hol_guard_scan');
  const result = await tool.execute('scan', {text: 'rm -rf SYNTHETIC_FIXTURE', source: 'fixture'}, undefined, undefined, {});
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
  const high = (await panels.snapshot())[0].data;
  assert.equal(high.latest.risk, 'blocked');
  process.stdout.write(JSON.stringify({review, high}));
} finally {
  await context.fiber.dispose();
}
'''], cwd=ROOT, text=True))

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['hol-guard'], new_session=False)
    response = audit.page.request.get(BASE + '/api/plugin-ui')
    assert response.ok
    snapshot = response.json()
    active_report = reports['review']
    def replace_panel(route):
        body = json.loads(json.dumps(snapshot))
        next(panel for panel in body['items'] if panel['id'] == 'hol-guard-panel')['data'] = active_report
        route.fulfill(status=200, content_type='application/json', body=json.dumps(body))
    try:
        page = audit.page
        page.route('**/api/plugin-ui', replace_panel)
        for name, text in [
            ('review', '输入无法序列化，未完成风险扫描，需要人工复核。'),
            ('high', '检测到可能删除、重置或覆盖数据的命令。'),
        ]:
            active_report = reports[name]
            page.reload(wait_until='networkidle')
            page.set_viewport_size({'width': 760, 'height': 960})
            page.get_by_role('button', name=re.compile(r'^插件，已安装')).click()
            page.get_by_role('button', name='查看 HOL Guard 详情', exact=True).click()
            card = page.locator('.plugin-panel-card').filter(has_text='HOL Guard')
            message = card.get_by_text(text, exact=True)
            expect(message).to_be_visible()
            message.scroll_into_view_if_needed()
            expect(card.get_by_text(re.compile('HOL Guard 不会阻止任何工具执行'))).to_be_visible()
            assert 'synthetic-private-marker' not in card.inner_text()
            assert card.evaluate('''el => {
                for(let node=el; node; node=node.parentElement)
                    if(node.scrollWidth > node.clientWidth + 1) return false;
                return true;
            }'''), 'Panel or an ancestor overflowed horizontally'
            page.screenshot(path=f'/tmp/pih-hol-guard-{name}.png')
        audit.finish()
        print('hol_guard_real_report_rendering PASS (isolated plugin + response injection; no model)', flush=True)
    finally:
        audit.page.unroute('**/api/plugin-ui', replace_panel)
        audit.close()
