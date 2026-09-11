"""Real worker-to-browser regression for a truncated SQLite TEXT cell."""
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['sql-lens'])
    try:
        result = audit.invoke('sql_readonly', {
            'database': 'scripts/fixtures/plugin-verification/sql-lens-audit.sqlite',
            'query': "SELECT printf('%.*c', 20000, 'x') AS content",
        })
        assert not result['isError']
        assert result['details']['rows'] == [{'content': 'x' * 16384 + '…'}]
        assert result['details']['truncated'] is True
        audit.panel('SQL Lens', ['1 rows', '面板显示 1 / 1 行；已迭代 1 行，行、列或单元格展示已截断。这不是匹配总行数。'])
        audit.finish()
        print('sql_lens_long_text PASS', flush=True)
    finally:
        audit.close()
