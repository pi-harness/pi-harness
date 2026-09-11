"""Verify UI availability without claiming model authentication has recovered."""
from playwright.sync_api import sync_playwright, expect

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless=False)
    try:
        page = browser.new_page(viewport={'width': 1440, 'height': 960})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('http://127.0.0.1:3144', wait_until='networkidle')
        expect(page.locator('.provider-auth-notice')).to_contain_text('模型尚未配置认证')
        plugins = page.request.get('http://127.0.0.1:3144/api/plugins').json()['items']
        assert any(item['name'] == '@pi-harness/plugin-code2skill' and item['state'] == 'active' for item in plugins)
        assert not errors, errors
        page.screenshot(path='/tmp/pih-local-ui-recovery.png')
        print('local_ui_and_code2skill_loaded PASS; model_auth_missing CONFIRMED', flush=True)
    finally:
        browser.close()
