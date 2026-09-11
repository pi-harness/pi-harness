"""Headed native MCP bridge verification against an inert real stdio server."""
import json
import os
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

ROOT = Path('/Volumes/librefang/worktrees/plugin-functional-verification')
COMMAND = ['node', str(ROOT / 'scripts/fixtures/plugin-verification/mcp/server.mjs')]

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['mcp-client', 'skill-catalog'])
    server_id = 'audit-' + audit.marker.lower()
    running = False
    try:
        result = audit.invoke('mcp_server_start', {'command': COMMAND, 'serverId': server_id})
        assert not result['isError'] and result['details']['status'] == 'running'
        running = True
        result = audit.invoke('mcp_list_tools', {'serverId': server_id})
        assert not result['isError'] and len(result['details']['tools']) == 3
        assert json.loads(result['content'][0]['text'])['tools'][0]['inputSchema']['required'] == ['auditValue']
        audit.panel('MCP Client', [server_id, 'audit_echo', 'audit_structured', 'audit_error'])
        result = audit.invoke('mcp_list_tools', {'serverId': server_id, 'limit': 1})
        page = json.loads(result['content'][0]['text'])
        assert page['shown'] == 1 and page['nextOffset'] == 1 and page['truncated']
        result = audit.invoke('mcp_list_tools', {'serverId': server_id, 'offset': 1, 'limit': 2})
        page = json.loads(result['content'][0]['text'])
        assert page['shown'] == 2 and page['nextOffset'] is None
        result = audit.invoke('mcp_list_tools', {'serverId': server_id, 'name': 'audit_echo'})
        selected = json.loads(result['content'][0]['text'])['tools']
        assert len(selected) == 1 and selected[0]['inputSchema']['required'] == ['auditValue']
        result = audit.invoke('mcp_call', {'serverId': server_id, 'name': 'audit_echo', 'arguments': {'auditValue': audit.marker}})
        assert not result['isError']
        echo = json.loads(result['content'][0]['text'])
        assert echo['value'] == audit.marker and echo['cwd'] == str(ROOT)
        child_pid = echo['pid']
        os.kill(child_pid, 0)
        result = audit.invoke('mcp_call', {'serverId': server_id, 'name': 'audit_error', 'arguments': {}})
        assert result['isError'] and 'Deliberate synthetic tool failure' in result['content'][0]['text']
        result = audit.invoke('mcp_call', {'serverId': server_id, 'name': 'audit_structured', 'arguments': {}})
        assert not result['isError'] and result['details']['structuredContent']['count'] == 7
        assert any('PIH_STRUCTURED_FIXTURE' in part.get('text', '') for part in result['content'])
        result = audit.invoke('mcp_list_resources', {'serverId': server_id})
        assert not result['isError'] and len(result['details']['resources']) == 2
        result = audit.invoke('mcp_read_resource', {'serverId': server_id, 'uri': 'audit://resource/2'})
        assert not result['isError'] and 'PIH_RESOURCE_FIXTURE' in result['content'][0]['text']
        result = audit.invoke('mcp_list_prompts', {'serverId': server_id})
        assert not result['isError'] and result['details']['prompts'][0]['arguments'][0]['required']
        assert json.loads(result['content'][0]['text'])['prompts'][0]['arguments'][0]['name'] == 'subject'
        result = audit.invoke('mcp_get_prompt', {'serverId': server_id, 'name': 'audit_prompt', 'arguments': {'subject': audit.marker}})
        assert not result['isError'] and 'Review ' + audit.marker in result['content'][0]['text']
        audit.new_session()
        result = audit.invoke('mcp_server_status', {})
        assert not result['isError'] and any(s['id'] == server_id and s['status'] == 'running' for s in result['details']['servers'])
        result = audit.invoke('mcp_call', {'serverId': server_id, 'name': 'audit_echo', 'arguments': {'auditValue': 'after-session-switch'}})
        assert not result['isError'] and json.loads(result['content'][0]['text'])['pid'] == child_pid
        result = audit.invoke('mcp_server_stop', {'serverId': server_id})
        assert not result['isError']
        running = False
        result = audit.invoke('mcp_server_status', {})
        assert not result['isError'] and not any(s['id'] == server_id for s in result['details']['servers'])
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            pass
        else:
            raise AssertionError('Stopped fixture process must be reaped')
        result = audit.invoke('mcp_call', {'command': COMMAND, 'name': 'audit_echo', 'arguments': {'auditValue': 'one-shot'}})
        assert not result['isError']
        once = json.loads(result['content'][0]['text'])
        assert once['value'] == 'one-shot'
        try:
            os.kill(once['pid'], 0)
        except ProcessLookupError:
            pass
        else:
            raise AssertionError('One-shot fixture process must be reaped before returning')
        audit.finish()
        print('mcp_real_stdio_workflow PASS', flush=True)
    finally:
        original_error = sys.exc_info()[1]
        try:
            if running:
                try:
                    result = audit.invoke('mcp_server_stop', {'serverId': server_id})
                    assert not result['isError'], 'Failed to clean up audit server'
                except Exception as cleanup_error:
                    if original_error is None:
                        raise
                    original_error.add_note('Audit MCP cleanup also failed: ' + type(cleanup_error).__name__)
        finally:
            audit.close()
