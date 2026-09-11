"""Real MCP Console discovery and confirmed, backed-up synthetic profile writes."""
import json
import subprocess
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

ROOT = Path('/Volumes/librefang/worktrees/plugin-functional-verification')
PATCH = ROOT / '.pih-agent/production-audit-mcp-panel.yml'
COMMAND = ['node', str(ROOT / 'scripts/fixtures/plugin-verification/mcp/server.mjs')]

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['mcp-panel', 'mcp-client'])
    server_id = 'audit-' + audit.marker.lower()
    running = False
    try:
        before = PATCH.read_bytes() if PATCH.exists() else None
        result = audit.invoke('mcp_panel', {'action': 'preview', 'serverId': server_id, 'command': COMMAND, 'autoStart': False})
        assert not result['isError'] and server_id in result['details']['fragment']
        assert (PATCH.read_bytes() if PATCH.exists() else None) == before
        result = audit.invoke('mcp_panel', {'action': 'apply', 'serverId': server_id, 'command': COMMAND, 'autoStart': False, 'confirm': False}, allow_writes=True)
        assert result['isError'] and (PATCH.read_bytes() if PATCH.exists() else None) == before
        result = audit.invoke('mcp_server_start', {'serverId': server_id, 'command': COMMAND})
        assert not result['isError']
        running = True
        result = audit.invoke('mcp_panel', {'action': 'status'})
        assert not result['isError'] and any(s['id'] == server_id and s['toolCount'] is None for s in result['details']['servers'])
        audit.panel('MCP Panel', [server_id, '工具尚未查询'])
        result = audit.invoke('mcp_panel', {'action': 'tools', 'serverId': server_id})
        assert not result['isError'] and len(result['details']['tools']) == 3
        assert json.loads(result['content'][0]['text'])['tools'][0]['inputSchema']['required'] == ['auditValue']
        audit.panel('MCP Panel', [server_id, '3 个 MCP 工具'])
        result = audit.invoke('mcp_panel', {'action': 'health', 'serverId': server_id})
        assert not result['isError'] and result['details']['severity'] == 'ok'
        result = audit.invoke('mcp_server_stop', {'serverId': server_id})
        assert not result['isError']
        running = False
        for name in [server_id, server_id + '-second']:
            current = PATCH.read_bytes() if PATCH.exists() else b''
            result = audit.invoke('mcp_panel', {'action': 'apply', 'serverId': name, 'command': COMMAND, 'autoStart': False, 'confirm': True}, allow_writes=True)
            assert not result['isError']
            assert Path(result['details']['backup']).read_bytes() == current
            assert PATCH.stat().st_mode & 0o777 == 0o600
        final_bytes = PATCH.read_bytes()
        result = audit.invoke('mcp_panel', {'action': 'apply', 'serverId': server_id, 'command': COMMAND, 'autoStart': False, 'confirm': True}, allow_writes=True)
        assert result['isError'] and PATCH.read_bytes() == final_bytes
        checked = subprocess.run(['node', 'scripts/inspect-mcp-patch.mjs', str(PATCH)], cwd=ROOT, capture_output=True, text=True, check=True)
        report = json.loads(checked.stdout.strip().splitlines()[-1])
        print('generated_profile', report, flush=True)
        assert report['loadable'] and report['clientEntries'] == 1
        assert server_id in report['serverIds'] and server_id + '-second' in report['serverIds']
        audit.finish()
        print('mcp_panel_real_workflow PASS', flush=True)
    finally:
        original_error = sys.exc_info()[1]
        try:
            if running:
                try:
                    result = audit.invoke('mcp_server_stop', {'serverId': server_id})
                    assert not result['isError']
                except Exception as cleanup_error:
                    if original_error is None:
                        raise
                    original_error.add_note('Cleanup failed: ' + type(cleanup_error).__name__)
        finally:
            audit.close()
