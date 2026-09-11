from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    b = LivePluginBrowser(p, ['context-doctor'])
    result = b.invoke('context_doctor', {})
    assert result['isError'] is False, result
    b.panel('Context Doctor', ['Context Doctor'])
    b.finish()
    b.close()
    print('context-doctor headed PASS', flush=True)
