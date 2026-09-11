"""Verify a prepared maximum-size inert skill through the real headed tool."""
import hashlib
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser, BASE

fixture = Path('/Volumes/librefang/worktrees/plugin-functional-verification/.pih-agent/skills/pih-guard-workspace-probe/SKILL.md')
before = fixture.read_bytes()
assert len(before) == 128 * 1024
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['skill-guard'], new_session=False)
    try:
        result = audit.invoke('skill_guard_scan', {'query': 'pih-guard-workspace-probe'})
        assert not result['isError']
        assert json.loads(result['content'][0]['text']) == result['details']
        assert result['details']['total'] == 1
        report = result['details']['reports'][0]
        assert report['scannedBytes'] == 131072
        assert report['risk'] == 'safe' and report['findings'] == []
        audit.panel('Skill Guard', ['pih-guard-workspace-probe', '未命中规则'])
        assert audit.page.request.get(BASE + '/api/status', timeout=3000).ok
        assert hashlib.sha256(fixture.read_bytes()).digest() == hashlib.sha256(before).digest()
        audit.finish()
        print('maximum_size_real_scan_and_responsive_panel PASS', flush=True)
    finally:
        audit.close()
