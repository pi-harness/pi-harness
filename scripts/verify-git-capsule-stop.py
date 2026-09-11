"""Actual model/Git with an owned fsmonitor hook; visible Stop and capture recovery."""
import json
import os
from pathlib import Path
import shutil
import subprocess
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


with tempfile.TemporaryDirectory(prefix='pih-capsule-stop-') as temporary, sync_playwright() as p:
    workspace = Path(temporary).resolve()
    ready = workspace / 'hook-ready'
    hook = workspace / 'fsmonitor-hook'
    node = shutil.which('node')
    assert node
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=workspace)
    git('init', '-q')
    (workspace / 'tracked.txt').write_text('before\n')
    git('add', 'tracked.txt')
    (workspace / 'tracked.txt').write_text('after\n')
    hook.write_text('#!' + node + '\nconst parent=require("node:child_process").execFileSync("/bin/ps",["-p",String(process.ppid),"-o","command="],{encoding:"utf8"});'
                    'if(!parent.includes("diff --binary --no-ext-diff --no-textconv --src-prefix=a/"))process.exit(1);'
                    'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(' +
                    json.dumps(str(ready)) + ',String(process.pid));setTimeout(()=>process.exit(9),45000);\n')
    hook.chmod(0o700)
    git('config', 'core.fsmonitor', str(hook))
    audit = LivePluginBrowser(p, ['git-time-capsule'], new_session=False, wait_until='domcontentloaded')
    original = audit.page.request.get(BASE + '/api/session').json()
    assert original.get('sessionFile')
    pid = None
    try:
        assert audit.page.request.post(BASE + '/api/session/new', data={'cwd': str(workspace)}).ok
        audit.page.goto(BASE, wait_until='domcontentloaded')
        audit.page.get_by_role('textbox', name='Prompt', exact=True).fill(
            f'{audit.marker} 只实际调用一次 git_snapshot，参数严格为 {{}}。这是临时仓库的停止按钮测试。'
            '允许工具保存撤销胶囊，不要调用其他工具、不要重试。'
        )
        with audit.page.expect_response(lambda r: r.url.endswith('/api/prompt'), timeout=180000) as pending:
            audit.page.get_by_role('button', name='发送消息', exact=True).click()
            deadline = time.monotonic() + 120
            while not ready.is_file() and time.monotonic() < deadline:
                audit.page.wait_for_timeout(100)
            assert ready.is_file(), 'Real Git did not start the owned fsmonitor hook'
            pid = int(ready.read_text())
            assert pid > 0 and alive(pid)
            calls = [part for message in audit.messages() for part in message.get('content', [])
                     if isinstance(part, dict) and part.get('type') == 'toolCall']
            assert len(calls) == 1 and calls[0]['name'] == 'git_snapshot' and calls[0]['arguments'] == {}
            started = time.monotonic()
            audit.page.get_by_role('button', name='停止', exact=True).click()
        assert pending.value.ok and pending.value.json().get('aborted') is True
        deadline = started + 5
        while alive(pid) and time.monotonic() < deadline:
            audit.page.wait_for_timeout(50)
        if alive(pid):
            print(subprocess.check_output(['ps', '-p', str(pid), '-o', 'pid=,ppid=,pgid=,stat=,comm='], text=True), flush=True)
            raise AssertionError('Cancelled plugin-owned Git fsmonitor hook survived')
        calls = [part for message in audit.messages() for part in message.get('content', [])
                 if isinstance(part, dict) and part.get('type') == 'toolCall']
        assert len(calls) == 1 and calls[0]['name'] == 'git_snapshot' and calls[0]['arguments'] == {}
        panel = next(x['data'] for x in audit.page.request.get(BASE + '/api/plugin-ui').json()['items']
                     if x['id'] == 'git-time-capsule-panel')
        assert panel['latest']['action'] == 'capture' and panel['latest']['status'] == 'cancelled'
        assert 'operation was cancelled' in panel['latest']['error']
        assert 'Unknown' not in panel['latest']['error']
        assert 'name' not in panel['latest']
        print('actual_model_git_stop_reaped_fsmonitor_hook PASS', {'elapsedMs': round((time.monotonic() - started) * 1000)}, flush=True)
        audit.panel('Git Time Capsule', ['已取消'])
        shutil.copyfile('/tmp/pih-git-time-capsule.png', '/tmp/pih-git-capsule-stopped.png')
        git('config', '--unset', 'core.fsmonitor')
        result = audit.invoke('git_snapshot', {}, allow_writes=True)
        assert not result['isError'] and result['details']['files'] == 1
        assert (workspace / 'tracked.txt').read_text() == 'after\n'
        audit.panel('Git Time Capsule', [result['details']['name'], '已完成'])
        audit.finish()
        print('actual_model_git_capture_recovery PASS', flush=True)
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
