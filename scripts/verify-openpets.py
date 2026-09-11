from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    b = LivePluginBrowser(p, ['openpets'])
    result = b.invoke('pet_react', {'action':'set_mood','mood':'focused'})
    assert result['isError'] is False, result
    b.panel('OpenPets', ['OpenPets'])
    b.finish()
    b.close()
    print('openpets headed PASS', flush=True)
