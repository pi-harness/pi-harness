"""Stop a real sleeping container from the visible application, then recover."""
import json
import subprocess
import time
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import LivePluginBrowser

def containers():
    output = subprocess.check_output([
        '/usr/local/bin/docker', 'ps', '-a', '--filter', 'name=pi-harness-sandbox-', '--format', '{{.ID}}',
    ], text=True, timeout=5)
    return set(output.split())

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['docker-sandbox'])
    baseline = containers()
    try:
        params = {'command': ['sleep', '60'], 'image': 'alpine:3.20', 'write': False, 'confirmWrite': False}
        before = len(audit.messages())
        audit.page.get_by_role('textbox', name='Prompt', exact=True).fill(
            f'{audit.marker} 请实际调用一次 sandbox_exec，参数严格为 {json.dumps(params)}。'
            '这是只等待、不读写文件的取消验证。不要调用其他工具，不要重试。'
        )
        with audit.page.expect_response(lambda r: r.url.endswith('/api/prompt'), timeout=180000) as pending:
            audit.page.get_by_role('button', name='发送消息', exact=True).click()
            deadline = time.monotonic() + 120
            owned = set()
            while not owned and time.monotonic() < deadline:
                owned = containers() - baseline
                if not owned:
                    audit.page.wait_for_timeout(200)  # Poll actual container creation, not a guessed startup sleep.
            assert len(owned) == 1, 'Expected one actual running sandbox container'
            identifier = next(iter(owned))
            state = subprocess.check_output(['/usr/local/bin/docker', 'inspect', identifier, '--format', '{{.State.Running}}'], text=True, timeout=5).strip()
            assert state == 'true'
            audit.page.get_by_role('button', name='停止', exact=True).click()
        assert pending.value.ok
        assert pending.value.json().get('aborted') is True
        assert not (containers() & owned), 'Stopped container was not removed'
        messages = audit.messages()[before:]
        calls = [part for m in messages for part in m.get('content', []) if isinstance(part, dict) and part.get('type') == 'toolCall']
        assert len(calls) == 1 and calls[0]['name'] == 'sandbox_exec' and calls[0]['arguments'] == params
        expect(audit.page.get_by_role('textbox', name='Prompt', exact=True)).to_be_visible()
        result = audit.invoke('sandbox_exec', {**params, 'command': ['printf', 'AFTER_CANCEL']})
        assert not result['isError'] and result['details']['output'] == 'AFTER_CANCEL'
        audit.panel('Docker Sandbox', ['exit 0', 'AFTER_CANCEL'])
        audit.finish()
        print('docker_cancel_cleanup_and_recovery PASS', flush=True)
    finally:
        audit.close()
