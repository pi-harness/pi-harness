"""Delay one real running status response; completed state must not regress."""
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['runtime-doctor'])
    held = []
    released = False
    def status_route(route):
        response = route.fetch(max_retries=2)
        if not held and response.json().get('status') == 'running':
            held.append((route, response, route.request.headers['x-audit-refresh-batch']))
            return
        route.fulfill(response=response)
    try:
        # Test-only observation of the real fetch/body reads. refresh() starts all
        # eleven requests synchronously; the microtask closes that batch before
        # any other event can initiate independent API traffic.
        audit.page.evaluate('''() => {
          const originalFetch = window.fetch.bind(window);
          const batches = window.__auditRefreshBatches = {};
          let active = null, next = 0;
          window.fetch = (input, init) => {
            const path = new URL(input, location.href).pathname;
            if (path === '/api/status') {
              active = {id: String(++next), paths: [], completed: []};
              batches[active.id] = active;
              queueMicrotask(() => { active = null; });
            }
            const batch = active;
            if (!batch) return originalFetch(input, init);
            batch.paths.push(path);
            const headers = new Headers(init?.headers);
            headers.set('x-audit-refresh-batch', batch.id);
            return originalFetch(input, {...init, headers}).then(response => {
              const json = response.json.bind(response);
              response.json = async () => {
                try { return await json(); }
                finally { batch.completed.push(path); }
              };
              return response;
            }, error => { batch.completed.push(path); throw error; });
          };
        }''')
        audit.page.route('**/api/status', status_route)
        result = audit.invoke('runtime_doctor', {})
        assert not result['isError'] and held, 'Must capture an actual in-flight running snapshot'
        indicator = audit.page.locator('.runtime-cells b').last
        expect(indicator).to_have_text('ready', timeout=15000)
        completed_count = len(audit.messages())
        expect(audit.page.locator('.runtime-cells b').nth(1)).to_have_text(str(completed_count))
        audit.page.evaluate('''completedCount => {
          window.__auditStatusRegressed = false;
          window.__auditStatusObserver = new MutationObserver(() => {
            const value = [...document.querySelectorAll('.runtime-cells b')].at(-1)?.textContent;
            const count = Number(document.querySelectorAll('.runtime-cells b')[1]?.textContent);
            if (value === 'running' || count < completedCount) window.__auditStatusRegressed = true;
          });
          window.__auditStatusObserver.observe(document.querySelector('.sidebar-footer'), {subtree:true, childList:true, characterData:true});
        }''', completed_count)
        held[0][0].fulfill(response=held[0][1])
        released = True
        audit.page.wait_for_function('''id => {
          const batch = window.__auditRefreshBatches[id];
          return batch.paths.length === 11 && batch.completed.length === 11;
        }''', arg=held[0][2], timeout=60000)
        paths = audit.page.evaluate('id => window.__auditRefreshBatches[id].paths', held[0][2])
        assert set(paths) == {'/api/status', '/api/session', '/api/sessions', '/api/files',
                              '/api/models', '/api/providers', '/api/plugins', '/api/plugin-ui',
                              '/api/marketplace', '/api/commands', '/api/workspaces'}, paths
        # All body reads have settled; allow the resulting React commit to paint.
        audit.page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        audit.page.screenshot(path='/tmp/pih-runtime-refresh-order.png')
        assert not audit.page.evaluate('window.__auditStatusRegressed'), 'An older running snapshot overwrote a completed run'
        expect(indicator).to_have_text('ready')
        audit.finish()
        print('runtime_refresh_order PASS', flush=True)
    finally:
        if held and not released:
            held[0][0].fulfill(response=held[0][1])
        audit.close()
