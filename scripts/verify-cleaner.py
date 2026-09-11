from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    b = LivePluginBrowser(p, ['cleaner'])
    result = b.invoke('clean_harness_artifacts', {'confirm': True})
    assert result['isError'] is False, result
    b.page.get_by_role('button', name='插件，已安装').click()
    expect(b.page.locator('.plugin-card').filter(has_text='Cleaner')).to_be_visible(timeout=15000)
    button = b.page.get_by_role('button', name='查看 Cleaner 详情', exact=True)
    expect(button).to_be_visible()
    button.click()
    expect(b.page.get_by_text('Harness Cleaner', exact=True).first).to_be_visible()
    print('plugins opened', flush=True)
    print([x for x in b.page.get_by_role('button').all_text_contents() if 'Cleaner' in x or '清理' in x][:20], flush=True)
    b.finish()
    b.close()
    print('cleaner headed PASS', flush=True)
