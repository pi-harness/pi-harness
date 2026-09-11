"""Verify missing ranking-source behavior without contacting a ranking feed."""
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['plugin-stars'])
    try:
        audit.panel('Plugin Stars', ['需要配置榜单来源 sourceUrl，尚未连接 Pi Harness 排行榜。'])
        result = audit.invoke('plugin_stars_search', {})
        assert result['isError']
        assert 'Configure plugin-stars sourceUrl' in result['content'][0]['text']
        audit.panel('Plugin Stars', ['需要配置榜单来源 sourceUrl，尚未连接 Pi Harness 排行榜。'])
        audit.finish()
        print('plugin_stars_missing_source PASS', flush=True)
    finally:
        audit.close()
