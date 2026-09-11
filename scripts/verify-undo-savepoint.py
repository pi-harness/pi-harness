from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    b = LivePluginBrowser(p, ['undo-savepoint'])
    result = b.invoke('undo_savepoint', {'action':'save','reason':'headed production verification'}, allow_writes=True)
    assert result['isError'] is False, result
    b.panel('Undo Savepoints', ['Undo Savepoints'])
    b.finish()
    b.close()
    print('undo-savepoint headed PASS', flush=True)
