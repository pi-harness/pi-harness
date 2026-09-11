from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    b = LivePluginBrowser(p, ['plugin-dev'])
    result = b.invoke('plugin_dev_reload', {'reason':'headed verification'})
    assert result['isError'] is False, result
    b.panel('Plugin Dev', ['Plugin Dev'])
    b.finish()
    b.close()
    print('plugin-dev headed PASS', flush=True)
