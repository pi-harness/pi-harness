"""Search the public npm registry without installing packages; verify every result."""
import json
from hashlib import sha256
from pathlib import Path
from uuid import uuid4
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import urlparse, parse_qs
import sys
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

workspace = Path(__file__).resolve().parents[1]
lockfile = workspace / 'package-lock.json'
before = sha256(lockfile.read_bytes()).hexdigest()
fixture_server = None
if '--fixture-registry' in sys.argv:
    class Registry(BaseHTTPRequestHandler):
        def do_GET(self):
            url = urlparse(self.path)
            if url.path != '/-/v1/search':
                self.send_error(404)
                return
            query = parse_qs(url.query).get('text', [''])[0]
            objects = [] if 'pih-audit-no-match-' in query else [
                {'package': {'name': f'@pi-harness/audit-{index}', 'version': '1.0.0',
                             'description': f'Synthetic capability 测试😀 {index}',
                             'links': {'npm': f'https://www.npmjs.com/package/@pi-harness/audit-{index}'}},
                 'score': {'final': 0.75}} for index in range(8)
            ]
            body = json.dumps({'total': len(objects), 'objects': objects}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *args):
            pass
    fixture_server = ThreadingHTTPServer(('127.0.0.1', 3187), Registry)
    Thread(target=fixture_server.serve_forever, daemon=True).start()
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['plugin-finder'])
    try:
        result = audit.invoke('plugin_search', {'query': 'pi-harness'})
        assert not result['isError']
        report = result['details']
        assert json.loads(result['content'][0]['text']) == report
        assert 5 < len(report['results']) <= 10, 'Need a real response covering the previously hidden results'
        assert report['total'] >= len(report['results'])
        assert any(item['description'] for item in report['results'])
        assert all(item['npm'].startswith('https://') for item in report['results'])
        audit.panel('Plugin Finder', ['查询：pi-harness', *[item['name'] for item in report['results']]])
        # Keep the no-match probe below npm's 64-character `text` limit after
        # the configured keyword prefix is added by the plugin.
        query = 'pih-no-match-' + uuid4().hex[:12]
        empty = audit.invoke('plugin_search', {'query': query})
        assert not empty['isError']
        assert empty['details']['results'] == []
        assert json.loads(empty['content'][0]['text']) == empty['details']
        audit.panel('Plugin Finder', ['查询：' + query, '没有找到匹配插件。'])
        assert sha256(lockfile.read_bytes()).hexdigest() == before
        audit.finish()
        print('plugin_finder_' + ('local_fixture' if fixture_server else 'public_registry') + '_all_results_empty PASS', flush=True)
    finally:
        audit.close()
        if fixture_server is not None:
            fixture_server.shutdown()
            fixture_server.server_close()
