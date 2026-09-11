"""Observe real container isolation and reject an unconfirmed writable mount."""
from pathlib import Path
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['docker-sandbox'])
    try:
        params = {'image': 'alpine:3.20', 'write': False, 'confirmWrite': False}
        network = audit.invoke('sandbox_exec', {**params, 'command': ['ip', '-o', 'link']})
        assert not network['isError'] and network['details']['exitCode'] == 0
        interfaces = network['details']['output'].strip().splitlines()
        assert len(interfaces) == 1 and ': lo:' in interfaces[0], interfaces
        resources = audit.invoke('sandbox_exec', {
            **params, 'command': ['cat', '/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/cpu.max', '/sys/fs/cgroup/pids.max'],
        })
        assert not resources['isError'] and resources['details']['exitCode'] == 0
        memory, cpu, pids = resources['details']['output'].strip().splitlines()
        assert int(memory) == 512 * 1024 * 1024
        quota, period = map(int, cpu.split())
        assert quota == period and int(pids) == 256
        target = Path('scripts/fixtures/plugin-verification/docker-confirmation-probe')
        assert not target.exists()
        refused = audit.invoke('sandbox_exec', {
            **params, 'command': ['touch', '/workspace/' + str(target)], 'write': True,
        })
        assert refused['isError']
        assert 'Writable sandbox requires confirmWrite=true' in str(refused['content'])
        assert not target.exists()
        audit.panel('Docker Sandbox', ['exit 0', 'network:none', 'memory:512m', 'cpus:1', 'pids:256'])
        audit.finish()
        print('docker_isolation_and_confirmation PASS', flush=True)
    finally:
        audit.close()
