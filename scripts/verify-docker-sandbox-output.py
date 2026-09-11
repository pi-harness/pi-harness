"""A real container's long Unicode output must disclose truncation to model and UI."""
import re
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['docker-sandbox'])
    try:
        result = audit.invoke('sandbox_exec', {
            'command': ['awk', 'BEGIN { for (i=0;i<6000;i++) printf "界" }'],
            'image': 'alpine:3.20', 'write': False, 'confirmWrite': False,
        })
        assert not result['isError'] and result['details']['exitCode'] == 0
        output = result['details']['output']
        assert len(output.encode('utf-8')) <= 12000
        assert output.startswith('[Output truncated: showing tail only.]\n')
        assert '\ufffd' not in output
        assert '[Output truncated: showing tail only.]' in result['content'][0]['text']
        audit.panel('Docker Sandbox', ['exit 0'])
        audit.page.get_by_role('button', name=re.compile(r'^插件，已安装')).click()
        audit.page.get_by_role('button', name='查看 Docker Sandbox 详情', exact=True).click()
        notice = audit.page.locator('pre').filter(has_text='[Output truncated: showing tail only.]')
        expect(notice).to_be_visible()
        notice.scroll_into_view_if_needed()
        audit.page.screenshot(path='/tmp/pih-docker-sandbox-output.png')
        audit.finish()
        print('docker_output_truncation PASS', flush=True)
    finally:
        audit.close()
