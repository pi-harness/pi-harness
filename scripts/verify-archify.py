"""Force a partial real workspace scan and verify its model-visible completeness."""
import json
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['archify'])
    try:
        result = audit.invoke('architecture_map', {'maxNodes': 1})
        assert not result['isError']
        assert result['details']['truncated'] is True
        assert result['details']['mermaid'].startswith('flowchart LR')
        assert result['content'][0]['text'].startswith('{'), 'Model received only a diagram, without completeness metadata'
        assert json.loads(result['content'][0]['text']) == result['details']
        audit.panel('Architecture Map', ['扫描达到节点上限，架构图可能不完整。'])
        audit.finish()
        print('archify_partial_scan PASS', flush=True)
    finally:
        audit.close()
