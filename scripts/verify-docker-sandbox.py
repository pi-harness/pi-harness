"""Real local-image sandbox workflows in visible Chrome; no shell wrappers."""
import argparse
from pathlib import Path
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

parser = argparse.ArgumentParser()
parser.add_argument('--missing-image', action='store_true')
args = parser.parse_args()
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['docker-sandbox'])
    try:
        params = {'command': ['printf', 'PIH_SANDBOX_测试😀'], 'image': 'alpine:3.20', 'write': False, 'confirmWrite': False}
        result = audit.invoke('sandbox_exec', params)
        if args.missing_image:
            assert result['isError']
            assert 'Docker image is not available locally: alpine:3.20' in str(result['content'])
            audit.panel('Docker Sandbox', ['还没有沙箱运行。仅使用本地镜像，默认无网络、工作区只读。', 'pull:never'])
        else:
            assert not result['isError']
            assert result['details']['exitCode'] == 0
            assert result['details']['output'] == 'PIH_SANDBOX_测试😀'
            audit.panel('Docker Sandbox', ['exit 0', 'PIH_SANDBOX_测试😀', 'network:none', 'workspace:read-only'])
            target = Path('scripts/fixtures/plugin-verification/docker-readonly-probe')
            assert not target.exists()
            denied = audit.invoke('sandbox_exec', {
                **params, 'command': ['touch', '/workspace/' + str(target)],
            })
            assert denied['details']['exitCode'] != 0
            assert denied['details']['status'] == 'failed'
            assert 'Read-only file system' in denied['details']['output']
            assert not target.exists()
            audit.panel('Docker Sandbox', ['exit 1', '工作区只读'])
        audit.finish()
        print('docker_sandbox PASS; missing_image=' + str(args.missing_image), flush=True)
    finally:
        audit.close()
