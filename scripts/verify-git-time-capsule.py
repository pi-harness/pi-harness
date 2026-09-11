"""Real-model capture/confirmed reverse-apply in a prepared, inert temporary repo."""
import json
from pathlib import Path
import subprocess
import sys

from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = Path(sys.argv[1]).resolve()
assert WORKSPACE.parent == Path('/tmp').resolve() and WORKSPACE.name.startswith('pih-git-capsule-live.')
assert (WORKSPACE / 'tracked.txt').read_bytes() == 'CAPSULE_UNSTAGED 中文😀\n'.encode()
assert (WORKSPACE / 'staged.txt').read_bytes() == b'CAPSULE_STAGED_KEEP\n'
assert (WORKSPACE / 'untracked.txt').read_bytes() == b'CAPSULE_UNTRACKED_KEEP\n'


def git(*args):
    return subprocess.check_output(['git', *args], cwd=WORKSPACE)


assert not git('remote'), 'Fixture must not have a remote'
staged_before = git('diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv')
assert staged_before
patch_before = git('diff', '--binary', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--', '.', ':(exclude).pi-harness/capsules')
assert patch_before

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['git-time-capsule'], new_session=False, wait_until='domcontentloaded')
    original = audit.page.request.get(BASE + '/api/session').json()
    assert original.get('sessionFile'), 'Need a persisted original session to restore navigation'
    try:
        response = audit.page.request.post(BASE + '/api/session/new', data={'cwd': str(WORKSPACE)})
        assert response.ok
        audit.page.goto(BASE, wait_until='domcontentloaded')
        result = audit.invoke('git_snapshot', {}, allow_writes=True)
        assert not result['isError']
        details = result['details']
        assert details['files'] == 1 and details['bytes'] == len(patch_before)
        name = details['name']
        assert Path(name).name == name and name.endswith('.patch')
        capsule = ROOT / '.pih-agent/capsules' / name
        assert capsule.read_bytes() == patch_before
        assert capsule.stat().st_mode & 0o777 == 0o600
        assert name in result['content'][0]['text']
        audit.panel('Git Time Capsule', [name])

        refused = audit.invoke('git_restore', {'name': name, 'confirm': False})
        assert refused['isError'] and 'requires confirm=true' in refused['content'][0]['text']
        assert (WORKSPACE / 'tracked.txt').read_bytes() == 'CAPSULE_UNSTAGED 中文😀\n'.encode()
        assert git('diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv') == staged_before

        restored = audit.invoke('git_restore', {'name': name, 'confirm': True}, allow_writes=True)
        assert not restored['isError'] and restored['details'] == {'name': name, 'restored': True}
        assert (WORKSPACE / 'tracked.txt').read_bytes() == b'BASE_TRACKED\n'
        assert (WORKSPACE / 'staged.txt').read_bytes() == b'CAPSULE_STAGED_KEEP\n'
        assert (WORKSPACE / 'untracked.txt').read_bytes() == b'CAPSULE_UNTRACKED_KEEP\n'
        assert git('diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv') == staged_before
        assert not git('diff', '--binary', '--no-ext-diff', '--no-textconv')
        panel = next(x['data'] for x in audit.page.request.get(BASE + '/api/plugin-ui').json()['items']
                     if x['id'] == 'git-time-capsule-panel')
        assert panel['latest']['action'] == 'restore' and panel['latest']['restored']
        assert panel['latest']['name'] == name and panel['latest']['status'] == 'completed'
        audit.panel('Git Time Capsule', [name])

        empty = audit.invoke('git_snapshot', {}, allow_writes=True)
        assert empty['isError'] and 'staged and untracked changes are excluded' in empty['content'][0]['text']
        assert capsule.read_bytes() == patch_before
        audit.finish()
        print('real_git_capsule_capture_confirmation_restore_and_exclusions PASS', flush=True)
        print(json.dumps({'capsule': name, 'fixture': str(WORKSPACE), 'files': details['files']}), flush=True)
    finally:
        try:
            response = audit.page.request.post(BASE + '/api/session/open', data={'path': original['sessionFile']})
            assert response.ok
            audit.page.goto(BASE, wait_until='domcontentloaded')
            assert audit.page.request.get(BASE + '/api/session').json()['sessionId'] == original['sessionId']
            print('original_session_restored PASS', flush=True)
        finally:
            audit.close()
