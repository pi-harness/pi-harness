"""Actual-model npm script, visible Stop, ignored-signal worker cleanup and recovery."""
import json
import os
from pathlib import Path
import tempfile
import time
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


with tempfile.TemporaryDirectory(prefix='pih-test-harness-stop-') as temporary, sync_playwright() as p:
    workspace = Path(temporary).resolve()
    ready = workspace / 'worker.pid'
    (workspace / 'worker.mjs').write_text(
        'import {writeFileSync} from "node:fs";process.on("SIGTERM",()=>{});writeFileSync(' +
        json.dumps(str(ready)) + ',String(process.pid));setTimeout(()=>process.exit(9),45000);\n')
    (workspace / 'parent.mjs').write_text(
        'import {spawn} from "node:child_process";spawn(process.execPath,["worker.mjs"],{stdio:"ignore"});\n')
    (workspace / 'package.json').write_text(json.dumps({'name': 'owned-test-stop-fixture', 'private': True, 'scripts': {
        'test': 'node parent.mjs', 'lint': 'node -e "process.stdout.write(\'TEST_HARNESS_RECOVERY\')"'}}) + '\n')
    audit = LivePluginBrowser(p, ['test-harness'], new_session=False, wait_until='domcontentloaded')
    original = audit.page.request.get(BASE + '/api/session').json()
    assert original.get('sessionFile')
    pid = None
    try:
        assert audit.page.request.post(BASE + '/api/session/new', data={'cwd': str(workspace)}).ok
        audit.page.goto(BASE, wait_until='domcontentloaded')
        params = {'script': 'test'}
        audit.page.get_by_role('textbox', name='Prompt', exact=True).fill(
            f'{audit.marker} 只实际调用一次 run_project_tests，参数严格为 {json.dumps(params)}。'
            '这是临时可信仓库的停止测试，只允许执行该脚本，不要调用其他工具或重试。')
        with audit.page.expect_response(lambda r: r.url.endswith('/api/prompt'), timeout=180000) as pending:
            audit.page.get_by_role('button', name='发送消息', exact=True).click()
            deadline = time.monotonic() + 120
            while not ready.is_file() and time.monotonic() < deadline:
                audit.page.wait_for_timeout(100)
            assert ready.is_file(), 'Real npm script did not start worker'
            pid = int(ready.read_text())
            assert pid > 0 and alive(pid)
            started = time.monotonic()
            audit.page.get_by_role('button', name='停止', exact=True).click()
        assert pending.value.ok and pending.value.json().get('aborted') is True
        deadline = started + 5
        while alive(pid) and time.monotonic() < deadline:
            audit.page.wait_for_timeout(50)
        assert not alive(pid), 'Stopped npm worker survived'
        calls = [part for message in audit.messages() for part in message.get('content', [])
                 if isinstance(part, dict) and part.get('type') == 'toolCall']
        assert len(calls) == 1 and calls[0]['name'] == 'run_project_tests' and calls[0]['arguments'] == params
        state = next(item['data'] for item in audit.page.request.get(BASE + '/api/plugin-ui').json()['items']
                     if item['id'] == 'test-harness-panel')
        assert state['latest']['status'] == 'cancelled' and state['latest']['exitCode'] is None
        print('actual_model_npm_stop_reaped_worker PASS', {'elapsedMs': round((time.monotonic() - started) * 1000)}, flush=True)
        result = audit.invoke('run_project_tests', {'script': 'lint'})
        assert not result['isError'] and result['details']['status'] == 'passed' and result['details']['exitCode'] == 0
        assert 'TEST_HARNESS_RECOVERY' in result['details']['output']
        audit.panel('Test Harness', [result['details']['output']])
        audit.finish()
        print('actual_model_npm_recovery PASS', flush=True)
    finally:
        try:
            stop = audit.page.get_by_role('button', name='停止', exact=True)
            if stop.is_visible():
                stop.click()
            assert audit.page.request.post(BASE + '/api/session/open', data={'path': original['sessionFile']}).ok
            audit.page.goto(BASE, wait_until='domcontentloaded')
            assert audit.page.request.get(BASE + '/api/session').json()['sessionId'] == original['sessionId']
            print('original_session_restored PASS', flush=True)
        finally:
            if pid is not None and alive(pid):
                os.kill(pid, 9)
            audit.close()
