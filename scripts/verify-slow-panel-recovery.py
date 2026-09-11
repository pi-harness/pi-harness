"""Held panel results must still render after newer status-only refreshes.

Only the browser panel response is injected; no model call or plugin mutation.
"""
import json
import re
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['hol-guard'], new_session=False, wait_until='domcontentloaded')
    held = []
    try:
        page = audit.page
        expect(page.locator('.runtime-cells b').last).to_have_text('ready')
        snapshot = page.request.get(BASE + '/api/plugin-ui').json()
        panel = next(item for item in snapshot['items'] if item['id'] == 'hol-guard-panel')
        panel['error'] = 'SLOW_PANEL_RECOVERY_AUDIT'
        page.evaluate('''() => {
          window.__panelAuditStatusReads = 0;
          window.__panelAuditPanelReads = 0;
          const original = window.fetch.bind(window);
          window.fetch = (input, init) => original(input, init).then(response => {
            const path = new URL(input, location.href).pathname;
            if (path === '/api/status' || path === '/api/plugin-ui') {
              const json = response.json.bind(response);
              response.json = async () => {
                const result = await json();
                if (path === '/api/status') window.__panelAuditStatusReads++;
                else window.__panelAuditPanelReads++;
                return result;
              };
            }
            return response;
          });
        }''')
        def hold(route):
            held.append(route)
        page.route('**/api/plugin-ui', hold)
        page.get_by_role('button', name=re.compile(r'^插件，已安装')).click()
        page.get_by_role('button', name='查看 HOL Guard 详情', exact=True).click()
        page.wait_for_function('() => window.__panelAuditStatusReads >= 2', timeout=20000)
        assert len(held) >= 2
        held.pop(0).fulfill(status=200, content_type='application/json', body=json.dumps(snapshot))
        expect(page.get_by_text('SLOW_PANEL_RECOVERY_AUDIT', exact=True)).to_be_visible()
        # Keep two later batches pending, render the newest panel first, then
        # release the older panel. Its partial and eventual full batch must not
        # replace the newer field value.
        page.wait_for_function('() => window.__panelAuditStatusReads >= 4', timeout=20000)
        assert len(held) >= 3
        panel['error'] = 'NEWEST_PANEL_AUDIT'
        held.pop().fulfill(status=200, content_type='application/json', body=json.dumps(snapshot))
        expect(page.get_by_text('NEWEST_PANEL_AUDIT', exact=True)).to_be_visible()
        page.evaluate('''() => {
          window.__panelRegressed = false;
          const card = [...document.querySelectorAll('.plugin-panel-card')]
            .find(el => el.textContent.includes('NEWEST_PANEL_AUDIT'));
          window.__panelObserver = new MutationObserver(() => {
            if (!card.textContent.includes('NEWEST_PANEL_AUDIT')) window.__panelRegressed = true;
          });
          window.__panelObserver.observe(card, {subtree:true, childList:true, characterData:true});
        }''')
        reads = page.evaluate('window.__panelAuditPanelReads')
        panel['error'] = 'STALE_PANEL_AUDIT'
        held.pop(0).fulfill(status=200, content_type='application/json', body=json.dumps(snapshot))
        page.wait_for_function('before => window.__panelAuditPanelReads > before', arg=reads)
        page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        assert not page.evaluate('window.__panelRegressed'), 'Older panel response replaced newer content'
        expect(page.get_by_text('NEWEST_PANEL_AUDIT', exact=True)).to_be_visible()
        expect(page.get_by_text('STALE_PANEL_AUDIT', exact=True)).to_have_count(0)
        page.evaluate('() => window.__panelObserver.disconnect()')
        page.screenshot(path='/tmp/pih-slow-panel-recovery.png')
        audit.finish()
        print('slow_panel_not_starved_by_newer_status PASS (controlled response)', flush=True)
        print('older_panel_cannot_replace_newer_panel PASS (controlled response)', flush=True)
    finally:
        while held:
            held.pop(0).continue_()
        audit.page.unroute('**/api/plugin-ui')
        audit.close()
