from playwright.sync_api import sync_playwright, expect
from uuid import uuid4
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    b = LivePluginBrowser(p, ['agent-teams'])
    member_id = 'planner-' + uuid4().hex[:8]
    result = b.invoke('team_task', {'action':'add_member','id':member_id,'name':'Planner','role':'planning','status':'idle'})
    assert result['isError'] is False, result
    b.panel('Agent Team Board', ['Planner', 'planning'])
    assert not b.errors, b.errors
    print('agent-teams headed PASS', flush=True)
    b.browser.close()
