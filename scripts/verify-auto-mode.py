from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    b = LivePluginBrowser(p, ['auto-mode'])
    result = b.invoke('auto_mode_exec', {'command':['printf','hello']})
    assert result['isError'] is False, result
    b.panel('Auto Mode', ['Auto Mode'])
    b.finish()
    b.close()
    print('auto-mode headed PASS', flush=True)
