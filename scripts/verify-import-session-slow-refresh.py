"""Imported history must render without waiting for marketplace refresh."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['theme-studio'])
    held = []
    try:
        page = audit.page
        audit.invoke('theme_status', {})
        source = page.request.get(BASE + '/api/session').json()
        content = Path(source['sessionFile']).read_bytes()
        audit.new_session()
        def hold(route):
            held.append(route)
            page.evaluate('() => { window.__marketplaceHeld = true; }')
        page.route('**/api/marketplace?*', hold)
        with page.expect_response(lambda r: r.url.endswith('/api/session/import')) as imported:
            page.get_by_label('导入会话文件', exact=True).set_input_files({
                'name': 'isolated-session-audit.jsonl',
                'mimeType': 'application/x-ndjson', 'buffer': content,
            })
        assert imported.value.ok
        receipt = imported.value.json()
        assert receipt['sessionId'] != source['sessionId'] and receipt['messages'] > 0
        expect(page.locator('button.session-row.active small')).to_have_text(f"{receipt['messages']} 条消息")
        expect(page.locator('article').filter(has_text=audit.marker).first).to_be_visible()
        page.wait_for_function('() => window.__marketplaceHeld === true', timeout=15000)
        assert held, 'The unrelated marketplace response must actually be held'
        print('import_session_independent_of_marketplace PASS', flush=True)
    finally:
        while held:
            held.pop(0).continue_()
        audit.page.unroute('**/api/marketplace?*', hold)
        audit.close()
