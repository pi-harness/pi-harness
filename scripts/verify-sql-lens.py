"""Real SQLite worker queries against a dedicated immutable synthetic database."""
import hashlib
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

database = 'scripts/fixtures/plugin-verification/sql-lens-audit.sqlite'
path = Path(database)
before = hashlib.sha256(path.read_bytes()).hexdigest()
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['sql-lens'])
    try:
        result = audit.invoke('sql_readonly', {'database': database, 'query': 'SELECT * FROM audit'})
        assert not result['isError']
        report = result['details']
        assert json.loads(result['content'][0]['text']) == report
        assert report['rows'] == [{'label': '测试😀', 'big': '9223372036854775807', 'payload': {'type':'blob', 'bytes':4, 'previewBase64':'AAEC/w==', 'truncated':False}, 'empty':None}]
        assert report['truncated'] is False and report['scannedRows'] == 1
        audit.panel('SQL Lens', ['1 rows', '列：label, big, payload, empty'])
        query = 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<105) SELECT x FROM n'
        capped = audit.invoke('sql_readonly', {'database':database, 'query':query})
        assert not capped['isError'] and len(capped['details']['rows']) == 100
        assert capped['details']['truncated'] is True and capped['details']['scannedRows'] == 101
        audit.panel('SQL Lens', ['100 rows', '面板显示 12 / 100 行；已迭代 101 行，行、列或单元格展示已截断。这不是匹配总行数。'])
        for query in ['PRAGMA user_version = 1', 'SELECT 1; SELECT 2']:
            rejected = audit.invoke('sql_readonly', {'database':database, 'query':query})
            assert rejected['isError']
            assert hashlib.sha256(path.read_bytes()).hexdigest() == before
            audit.panel('SQL Lens', ['查询失败', '100 rows'])
        assert hashlib.sha256(path.read_bytes()).hexdigest() == before
        audit.finish()
        print('sql_lens PASS', flush=True)
    finally:
        audit.close()
