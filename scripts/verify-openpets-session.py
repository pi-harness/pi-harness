from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    b = LivePluginBrowser(p, ['openpets'])
    first = b.invoke('pet_react', {'action':'set_mood','mood':'focused'})
    assert first['isError'] is False, first
    before = b.page.request.get('http://127.0.0.1:3144/api/plugin-ui').json()
    b.new_session()
    after = b.page.request.get('http://127.0.0.1:3144/api/plugin-ui').json()
    panel = next(x for x in after['items'] if x['id'] == 'openpets-panel')
    assert panel['data']['mood'] != 'focused', panel
    print('openpets session isolation PASS', flush=True)
    b.close()
