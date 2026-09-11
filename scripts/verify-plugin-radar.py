"""Real GitHub topic discovery and complete model-visible metadata in headed Chrome."""
import json
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['plugin-radar'])
    try:
        result = audit.invoke('plugin_radar_search', {})
        assert not result['isError'], result['content']
        report = result['details']
        assert json.loads(result['content'][0]['text']) == report
        assert report['sources'] == ['topic:pi-harness', 'topic:pi-harness-plugin']
        assert report['total'] == len(report['results']) <= 10
        names = [item['fullName'] for item in report['results']]
        assert len(set(name.lower() for name in names)) == len(names)
        stars = [item['stars'] for item in report['results']]
        assert stars == sorted(stars, reverse=True)
        assert all(item['url'].startswith('https://github.com/') for item in report['results'])
        texts = names[:8] if names else ['未找到匹配的 Pi Harness 仓库。']
        audit.panel('Plugin Radar', texts)
        audit.finish()
        print('plugin_radar_real_github_metadata_panel PASS', flush=True)
    finally:
        audit.close()
