"""Real fixed 120-second Docker timeout, owned-container cleanup and recovery."""
import subprocess
import time
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

def containers():
    return set(subprocess.check_output([
        '/usr/local/bin/docker', 'ps', '-a', '--filter', 'name=pi-harness-sandbox-', '--format', '{{.ID}}',
    ], text=True, timeout=5).split())

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['docker-sandbox'])
    baseline = containers()
    try:
        params = {'command': ['sleep', '130'], 'image': 'alpine:3.20', 'write': False, 'confirmWrite': False}
        started = time.monotonic()
        result = audit.invoke('sandbox_exec', params)
        elapsed = time.monotonic() - started
        details = result['details']
        assert details['status'] == 'timed_out' and details['exitCode'] != 0, details
        assert details['command'] == ['sleep', '130'] and details['write'] is False
        assert elapsed >= 120
        assert containers() == baseline
        panel = next(x['data'] for x in audit.page.request.get(BASE + '/api/plugin-ui').json()['items']
                     if x['id'] == 'docker-sandbox-panel')
        assert panel['latest'] == details and panel['defaults']['timeoutMs'] == 120000
        print('real_timeout_and_container_cleanup PASS', {'promptElapsedSeconds': round(elapsed, 2)}, flush=True)
        audit.panel('Docker Sandbox', ['超时'])
        recovered = audit.invoke('sandbox_exec', {**params, 'command': ['printf', 'AFTER_REAL_TIMEOUT']})
        assert recovered['details']['status'] == 'completed'
        assert recovered['details']['output'] == 'AFTER_REAL_TIMEOUT'
        assert containers() == baseline
        audit.panel('Docker Sandbox', ['exit 0', 'AFTER_REAL_TIMEOUT'])
        audit.finish()
        print('same_session_after_timeout_recovery PASS', flush=True)
    finally:
        audit.close()
