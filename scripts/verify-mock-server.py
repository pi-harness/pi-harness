"""Real mock HTTP lifecycle, Unicode route response, query and method routing."""
import socket
import json
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['mock-server'])
    started = False
    try:
        result = audit.invoke('mock_server_start', {'port': 0})
        assert not result['isError'] and result['details']['running']
        started = True
        assert json.loads(result['content'][0]['text']) == result['details']
        url = result['details']['url']
        assert urlparse(url).hostname == '127.0.0.1'
        response = audit.page.request.get(url + '/pih-audit?probe=1')
        assert response.status == 201 and response.json() == {'message': '测试😀'}
        assert response.headers['x-pih-audit'] == 'local-fixture'
        assert audit.page.request.post(url + '/pih-audit', data='inert').status == 404
        status = audit.invoke('mock_server_status', {})
        assert status['details']['routes'] == 1
        assert status['details']['lastRequest'] == 'POST /pih-audit'
        assert json.loads(status['content'][0]['text']) == status['details']
        audit.panel('Mock Server', [url, '最近请求：POST /pih-audit'])
        stopped = audit.invoke('mock_server_stop', {})
        assert not stopped['isError'] and stopped['details']['stopped']
        started = False
        with socket.socket() as connection:
            connection.settimeout(2)
            assert connection.connect_ex(('127.0.0.1', urlparse(url).port)) != 0
        audit.finish()
        print('mock_server_http_lifecycle PASS', flush=True)
    finally:
        try:
            if started:
                audit.invoke('mock_server_stop', {})
        finally:
            audit.close()
