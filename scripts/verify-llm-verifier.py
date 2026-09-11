from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    b = LivePluginBrowser(p, ['llm-verifier'])
    result = b.invoke('llm_verify', {'claim':'2 + 2 = 4','evidence':'A calculator check returned 4.'})
    assert result['isError'] is False, result
    b.panel('LLM Verifier', ['LLM Verifier'])
    b.finish()
    b.close()
    print('llm-verifier headed PASS', flush=True)
