"""Ensure source Skills Catalog starts and works without an MCP provider."""
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['skill-catalog'])
    try:
        plugins = audit.page.request.get(BASE + '/api/plugins').json()['items']
        assert not any(x['name'] == '@pi-harness/plugin-mcp-client' and x['state'] == 'active' for x in plugins)
        result = audit.invoke('skill_catalog', {'action': 'list', 'query': 'pih-production-audit'})
        assert not result['isError'] and result['details']['total'] == 1
        result = audit.invoke('skill_catalog', {'action': 'read', 'name': 'pih-production-audit'})
        assert not result['isError'] and 'PIH_CATALOG_FIXTURE_BODY_20260909' in result['content'][0]['text']
        result = audit.invoke('skill_catalog', {'action': 'mcp'})
        assert not result['isError'] and result['details'] == {'available': False, 'total': 0, 'truncated': False, 'servers': []}
        audit.panel('Skills Catalog', ['pih-production-audit', '不可用'])
        audit.finish()
        print('standalone_skill_catalog PASS', flush=True)
    finally:
        audit.close()
