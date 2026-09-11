"""Exercise search and dependency plugins against bounded repository fixtures."""
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

ROOT = 'scripts/fixtures/plugin-verification'
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['workspace-search', 'module-search', 'dependency-checker'])
    try:
        result = audit.invoke('workspace_search', {'query': 'SEARCH_FIXTURE_NEEDLE', 'path': ROOT + '/search'})
        assert not result['isError']
        assert result['details']['matchCount'] == 2
        assert [m['line'] for m in result['details']['matches']] == [2, 4]
        audit.panel('Workspace Search', ['2 个匹配', ROOT + '/search/sample.js:2'])
        result = audit.invoke('workspace_search', {'query': 'SEARCH_FIXTURE_NEEDLE', 'path': ROOT + '/search', 'maxResults': 1})
        assert not result['isError'] and result['details']['matchCount'] == 1 and result['details']['truncated']
        audit.panel('Workspace Search', ['结果不完整：已达到扫描、读取或结果上限，存在跳过文件，或匹配片段已裁剪。'])
        result = audit.invoke('workspace_search', {'query': 'ABSENT_SEARCH_FIXTURE', 'path': ROOT + '/search'})
        assert not result['isError'] and result['details']['matchCount'] == 0
        audit.panel('Workspace Search', ['没有找到匹配内容。'])
        result = audit.invoke('module_search', {'query': 'SearchFixture', 'kind': 'all', 'path': ROOT + '/search'})
        assert not result['isError']
        assert len(result['details']['matches']) == 2
        assert all(m['kind'] == 'export' for m in result['details']['matches'])
        audit.panel('Module Search', ['2 个结果', 'SearchFixtureAlpha', 'SearchFixtureBeta'])
        result = audit.invoke('module_search', {'query': 'SearchFixture', 'kind': 'all', 'path': ROOT + '/search', 'maxResults': 1})
        assert not result['isError'] and len(result['details']['matches']) == 1 and result['details']['truncated']
        assert any('Incomplete search' in part.get('text', '') for part in result['content'])
        audit.panel('Module Search', ['结果不完整：已达到扫描、读取或结果上限，存在跳过文件，或匹配片段已裁剪。'])
        result = audit.invoke('module_search', {'query': 'basename', 'kind': 'import', 'path': ROOT + '/search'})
        assert not result['isError']
        assert [m['name'] for m in result['details']['matches']] == ['basename']
        audit.panel('Module Search', ['1 个结果', 'basename'])
        result = audit.invoke('module_search', {'query': 'ABSENT_MODULE_FIXTURE', 'path': ROOT + '/search'})
        assert not result['isError'] and not result['details']['matches']
        audit.panel('Module Search', ['没有找到匹配的模块符号。'])
        result = audit.invoke('dependency_check', {'manifest': ROOT + '/dependencies/package.json'})
        assert not result['isError']
        report = result['details']
        assert report['missing'] == ['pih-verification-deliberately-missing']
        assert report['installed'] == 1
        assert len(report['conflicts']) == 1 and report['conflicts'][0]['name'] == 'react'
        audit.panel('Dependency Checker', ['版本冲突', '缺失 1、无效 0：pih-verification-deliberately-missing'])
        audit.finish()
        print('search_plugins PASS', flush=True)
    except Exception as error:
        print('verification_failed', type(error).__name__, str(error), flush=True)
        raise
    finally:
        audit.close()
