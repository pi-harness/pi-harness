"""Stop a real SIGTERM-ignoring command from the headed UI and verify reaping."""
import json
import argparse
import os
import tempfile
import time
from pathlib import Path
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--tree', action='store_true', help='Also verify a child that outlives its direct parent')
options = parser.parse_args()

def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False

with tempfile.TemporaryDirectory(prefix='pih-auto-cancel-live-') as directory, sync_playwright() as p:
    ready = Path(directory) / 'ready'
    audit = LivePluginBrowser(p, ['auto-mode'], new_session=False, wait_until='domcontentloaded')
    original = audit.page.request.get(BASE + '/api/session').json()
    assert original.get('sessionFile') and Path(original['sessionFile']).is_file()
    try:
        assert audit.page.request.post(BASE + '/api/session/new', data={'cwd': str(ROOT)}).ok
        audit.page.goto(BASE, wait_until='domcontentloaded')
        script = 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(' + json.dumps(str(ready)) + ',String(process.pid));setInterval(()=>{},1000);setTimeout(()=>process.exit(9),45000)'
        parent_ready = Path(directory) / 'parent'
        if options.tree:
            script = 'require("node:fs").writeFileSync(' + json.dumps(str(parent_ready)) + ',String(process.pid));require("node:child_process").spawn(process.execPath,["-e",' + json.dumps(script) + '],{stdio:"ignore"})'
        params = {'command': ['node', '-e', script], 'confirm': True}
        audit.page.get_by_role('textbox', name='Prompt', exact=True).fill(
            f'{audit.marker} 只实际调用一次 auto_mode_exec，参数严格为 {json.dumps(params)}。'
            '这是停止按钮验证，只允许写参数里指定的合成标记文件，不做其他文件操作。不要调用其他工具或重试。'
        )
        with audit.page.expect_response(lambda r: r.url.endswith('/api/prompt'), timeout=180000) as pending:
            audit.page.get_by_role('button', name='发送消息', exact=True).click()
            deadline = time.monotonic() + 120
            while not ready.is_file() and time.monotonic() < deadline:
                audit.page.wait_for_timeout(100)
            assert ready.is_file(), 'Actual command did not signal readiness'
            pid = int(ready.read_text())
            assert pid > 0 and alive(pid)
            parent_pid = int(parent_ready.read_text()) if options.tree else pid
            assert parent_pid > 0 and alive(parent_pid)
            started = time.monotonic()
            audit.page.get_by_role('button', name='停止', exact=True).click()
        assert pending.value.ok and pending.value.json().get('aborted') is True
        deadline = started + 5
        while alive(pid) and time.monotonic() < deadline:
            audit.page.wait_for_timeout(50)
        assert not alive(pid), 'Stopped command remains alive'
        assert not alive(parent_pid), 'Stopped parent remains alive'
        calls = [part for message in audit.messages() for part in message.get('content', [])
                 if isinstance(part, dict) and part.get('type') == 'toolCall']
        assert len(calls) == 1 and calls[0]['name'] == 'auto_mode_exec' and calls[0]['arguments'] == params
        panel = next(x['data'] for x in audit.page.request.get(BASE + '/api/plugin-ui').json()['items'] if x['id'] == 'auto-mode-panel')
        assert panel['last'] is None
        print('actual_stop_reaped_ignoring_child PASS', {'tree': options.tree, 'elapsedMs': round((time.monotonic() - started) * 1000)}, flush=True)
        result = audit.invoke('auto_mode_exec', {'command': ['printf', 'AFTER_HARD_CANCEL']})
        assert not result['isError'] and result['details']['exitCode'] == 0
        assert result['details']['stdout'] == 'AFTER_HARD_CANCEL'
        audit.panel('Auto Mode', ['exit 0', 'AFTER_HARD_CANCEL'])
        audit.finish()
        print('hard_cancel_recovery PASS', flush=True)
    finally:
        try:
            stop = audit.page.get_by_role('button', name='停止', exact=True)
            if stop.is_visible():
                stop.click()
            restored = audit.page.request.post(BASE + '/api/session/open', data={'path': original['sessionFile']})
            assert restored.ok, f'Session restore HTTP {restored.status}'
            audit.page.goto(BASE, wait_until='domcontentloaded')
            assert audit.page.request.get(BASE + '/api/session').json()['sessionId'] == original['sessionId']
            print('original_session_restored PASS', flush=True)
        finally:
            audit.close()
