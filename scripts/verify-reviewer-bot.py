"""Actual model and real Git in an owned repository; headed report and error checks."""
import os
import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

parser = argparse.ArgumentParser()
parser.add_argument('--large', action='store_true', help='Verify oversized diff status and retained-report recovery')
options = parser.parse_args()

with tempfile.TemporaryDirectory(prefix='pih-reviewer-live-') as directory, sync_playwright() as p:
    root = Path(directory).resolve()
    env = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_SYSTEM': os.devnull}
    for key in ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']:
        env.pop(key, None)
    def git(*args):
        subprocess.run(['git', *args], cwd=root, env=env, check=True, capture_output=True)
    git('init', '-q')
    (root / 'sample.txt').write_text('base\n')
    git('add', 'sample.txt')
    git('-c', 'user.name=Pi Audit', '-c', 'user.email=audit@example.invalid', 'commit', '-qm', 'synthetic base')
    (root / 'sample.txt').write_text('TODO synthetic review marker\n')
    audit = LivePluginBrowser(p, ['reviewer-bot'], new_session=False, wait_until='domcontentloaded')
    original = audit.page.request.get(BASE + '/api/session').json()
    assert original.get('sessionFile') and Path(original['sessionFile']).is_file()
    try:
        assert audit.page.request.post(BASE + '/api/session/new', data={'cwd': str(root)}).ok
        audit.page.goto(BASE, wait_until='domcontentloaded')
        result = audit.invoke('review_changes', {})
        assert not result['isError']
        report = result['details']
        assert report['cwd'] == str(root) and report['status'] == 'warning'
        assert report['changedFiles'] == 1 and report['findingCount'] == 1
        assert report['files'] == [{'path': 'sample.txt', 'added': 1, 'removed': 1}]
        assert report['findings'][0]['kind'] == 'todo' and report['findings'][0]['path'] == 'sample.txt'
        panel = next(x['data'] for x in audit.page.request.get(BASE + '/api/plugin-ui').json()['items'] if x['id'] == 'reviewer-bot-panel')
        assert panel['latest'] == report
        audit.panel('Reviewer Bot', ['需要关注', 'sample.txt'])
        print('real_git_warning_exact_report PASS', flush=True)
        if options.large:
            limit = panel['maxDiffBytes']
            assert isinstance(limit, int) and 16384 <= limit <= 8388608
            (root / 'sample.txt').write_text('x' * (limit + 4096) + '\n')
            failed = audit.invoke('review_changes', {})
            diagnostic = f'Git review diff output exceeded {limit} bytes; review is incomplete'
            assert failed['isError'] and diagnostic in str(failed['content'])
            panel = next(x['data'] for x in audit.page.request.get(BASE + '/api/plugin-ui').json()['items'] if x['id'] == 'reviewer-bot-panel')
            assert panel['status'] == 'failed' and panel['latestStale'] is True
            assert panel['lastError'] == diagnostic and panel['latest'] == report
            audit.panel('Reviewer Bot', [f'操作失败：{diagnostic}', '上次成功结果（非本次审阅）'])
            shutil.copyfile('/tmp/pih-reviewer-bot.png', '/tmp/pih-reviewer-large.png')
            print('real_large_diff_failure_historical_report PASS', flush=True)
            (root / 'sample.txt').write_text('recovered plain change\n')
            recovered = audit.invoke('review_changes', {})
            assert not recovered['isError'] and recovered['details']['status'] == 'pass'
            panel = next(x['data'] for x in audit.page.request.get(BASE + '/api/plugin-ui').json()['items'] if x['id'] == 'reviewer-bot-panel')
            assert panel['status'] == 'completed' and panel['lastError'] is None and panel['latestStale'] is False
            audit.panel('Reviewer Bot', ['未命中检查规则'])
            print('real_review_recovery_clears_failure PASS', flush=True)
        empty = root / 'unborn'
        empty.mkdir()
        subprocess.run(['git', 'init', '-q'], cwd=empty, env=env, check=True, capture_output=True)
        assert audit.page.request.post(BASE + '/api/session/new', data={'cwd': str(empty)}).ok
        audit.page.goto(BASE, wait_until='domcontentloaded')
        failed = audit.invoke('review_changes', {})
        assert failed['isError']
        assert 'requires a repository with a readable HEAD' in str(failed['content'])
        panel = next(x['data'] for x in audit.page.request.get(BASE + '/api/plugin-ui').json()['items'] if x['id'] == 'reviewer-bot-panel')
        assert panel['latest'] is None
        audit.panel('Reviewer Bot', ['还没有审查当前改动。可让 Agent 调用 review_changes。'])
        audit.finish()
        print('unborn_repository_refusal_without_report PASS', flush=True)
    finally:
        try:
            restored = audit.page.request.post(BASE + '/api/session/open', data={'path': original['sessionFile']})
            assert restored.ok
            audit.page.goto(BASE, wait_until='domcontentloaded')
            assert audit.page.request.get(BASE + '/api/session').json()['sessionId'] == original['sessionId']
            print('original_session_restored PASS', flush=True)
        finally:
            audit.close()
