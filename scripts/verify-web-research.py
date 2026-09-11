from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    b = LivePluginBrowser(p, ['web-research'])
    result = b.invoke('web_search', {'query':'Pi Harness documentation'})
    # External provider may be unavailable in this profile; either outcome must be a bounded tool result.
    assert result.get('content'), result
    b.panel('Web Research', ['Web Research'])
    b.finish()
    b.close()
    print('web-research headed PASS', flush=True)
