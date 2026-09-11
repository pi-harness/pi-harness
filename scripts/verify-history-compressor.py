from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    b = LivePluginBrowser(p, ['history-compressor'])
    result = b.invoke('compress_history', {'confirm':True})
    assert result['isError'] is False, result
    b.panel('History Compressor', ['History Compressor'])
    b.finish()
    b.close()
    print('history-compressor headed PASS', flush=True)
