"""Exercise the real configured timeout and the next query in headed Chrome."""
import hashlib
from pathlib import Path
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

database = 'scripts/fixtures/plugin-verification/sql-lens-audit.sqlite'
before = hashlib.sha256(Path(database).read_bytes()).hexdigest()
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['sql-lens'])
    try:
        result = audit.invoke('sql_readonly', {
            'database': database,
            'query': 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) AS total FROM n',
        })
        assert result['isError']
        assert 'SQL Lens query timed out after 5000ms' in str(result['content'])
        audit.panel('SQL Lens', ['查询失败', 'SQL Lens query timed out after 5000ms'])
        recovery = audit.invoke('sql_readonly', {'database': database, 'query': 'SELECT 42 AS recovered'})
        assert not recovery['isError']
        assert recovery['details']['rows'] == [{'recovered': 42}]
        audit.panel('SQL Lens', ['已完成', '1 rows', '列：recovered'])
        assert hashlib.sha256(Path(database).read_bytes()).hexdigest() == before
        audit.finish()
        print('sql_lens_timeout_and_recovery PASS', flush=True)
    finally:
        audit.close()
