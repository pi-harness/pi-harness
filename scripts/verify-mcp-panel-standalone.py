"""Exercise MCP Console without enabling the MCP service provider."""
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['mcp-panel'])
    try:
        plugins = audit.page.request.get(BASE + '/api/plugins').json()['items']
        assert not any(x['name'] == '@pi-harness/plugin-mcp-client' and x['state'] == 'active' for x in plugins)
        result = audit.invoke('mcp_panel', {'action': 'status'})
        assert not result['isError'] and result['details']['available'] is False
        audit.panel('MCP Panel', ['MCP 不可用'])
        result = audit.invoke('mcp_panel', {'action': 'preview', 'serverId': 'preview-only', 'command': ['node', 'synthetic.mjs'], 'autoStart': False})
        assert not result['isError'] and result['details']['action'] == 'preview'
        result = audit.invoke('mcp_panel', {'action': 'tools', 'serverId': 'missing'})
        assert result['isError'] and 'enable the MCP client' in result['content'][0]['text']
        audit.finish()
        print('standalone_mcp_panel PASS', flush=True)
    finally:
        audit.close()
