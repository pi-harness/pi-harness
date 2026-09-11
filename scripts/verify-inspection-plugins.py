"""Real read-only workspace, skill, and plugin inspection in headed Chrome."""
import json
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import LivePluginBrowser


with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['workspace-navigator', 'skill-catalog', 'plugin-check'])
    try:
        path = 'scripts/fixtures/plugin-verification/search'
        result = audit.invoke('workspace_tree', {'path': path})
        assert not result['isError'] and not result['details']['truncated']
        assert any(n['name'] == 'sample.js' for n in result['details']['nodes'])
        audit.panel('Workspace Navigator', ['sample.js'])
        result = audit.invoke('workspace_tree', {'path': 'scripts/fixtures/plugin-verification', 'maxNodes': 1})
        assert not result['isError'] and result['details']['truncated'] and len(result['details']['nodes']) == 1
        audit.panel('Workspace Navigator', ['目录树已截断；面板显示 1 / 1 个已收集节点。'])
        result = audit.invoke('workspace_tree', {'path': '/tmp'})
        assert result['isError']
        result = audit.invoke('workspace_status', {})
        assert not result['isError'] and result['details']['available'] and not result['details']['clean']
        assert any(e['path'] == 'packages/client-web/src/react-room.tsx' for e in result['details']['entries'])
        audit.panel('Workspace Navigator', ['Git 状态'])
        result = audit.invoke('skill_catalog', {'action': 'list', 'query': audit.marker})
        assert not result['isError'] and result['details']['total'] == 0 and result['details']['skills'] == []
        result = audit.invoke('skill_catalog', {'action': 'read', 'name': audit.marker})
        assert result['isError']
        result = audit.invoke('skill_catalog', {'action': 'list', 'query': 'pih-production-audit'})
        assert not result['isError'] and result['details']['total'] == 1
        assert result['details']['skills'][0]['modelInvocationDisabled']
        result = audit.invoke('skill_catalog', {'action': 'read', 'name': 'pih-production-audit'})
        assert not result['isError'] and 'PIH_CATALOG_FIXTURE_BODY_20260909' in result['content'][0]['text']
        result = audit.invoke('skill_catalog', {'action': 'mcp'})
        assert not result['isError'] and result['details']['available']
        assert json.loads(result['content'][0]['text']) == result['details']
        audit.panel('Skills Catalog', ['Skills', 'MCP 服务器', 'pih-production-audit', '已加载，仅允许显式调用'])
        result = audit.invoke('plugin_check', {'action': 'check', 'path': path})
        assert not result['isError'] and result['details']['verdict'] == 'fail'
        assert any(e['code'] == 'no-manifest' for e in result['details']['errors'])
        assert json.loads(result['content'][0]['text']) == result['details']
        audit.panel('Plugin Check', ['no-manifest'])
        result = audit.invoke('plugin_check', {'action': 'scan', 'path': 'packages/plugins'})
        assert not result['isError'] and result['details']['scanned'] == 1 and result['details']['truncated']
        assert json.loads(result['content'][0]['text']) == result['details']
        audit.panel('Plugin Check', ['结果不完整：已达到扫描、读取或结果上限，存在跳过文件，或匹配片段已裁剪。'])
        result = audit.invoke('plugin_check', {'action': 'schema'})
        assert not result['isError'] and len(result['details']['checks']) == 10
        assert json.loads(result['content'][0]['text']) == result['details']
        audit.panel('Plugin Check', ['检查清单：10 项', 'package.json exists and is valid JSON'])
        result = audit.invoke('plugin_check', {'action': 'check', 'path': 'packages/plugins/prompt-library'})
        assert not result['isError'] and result['details']['verdict'] == 'pass'
        audit.panel('Plugin Check', ['pass'])
        audit.finish()
        print('inspection_workflows PASS', flush=True)
    except Exception as error:
        print('verification_failed', type(error).__name__, str(error), flush=True)
        raise
    finally:
        audit.close()
