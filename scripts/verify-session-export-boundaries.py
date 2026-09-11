"""Actual-model export path rejection against owned filesystem sentinels."""
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

with tempfile.TemporaryDirectory(prefix='pih-export-boundaries-') as temporary, sync_playwright() as p:
    root = Path(temporary).resolve()
    workspace = root / 'workspace'
    outside = root / 'outside'
    workspace.mkdir()
    outside.mkdir()
    sentinel = outside / 'sentinel.md'
    expected = b'Owned export boundary sentinel: do not overwrite.\n'
    sentinel.write_bytes(expected)
    (workspace / 'linked-file.md').symlink_to(sentinel)
    (workspace / 'linked-directory').symlink_to(outside, target_is_directory=True)
    audit = LivePluginBrowser(p, ['session-export'], new_session=False, wait_until='domcontentloaded')
    original = audit.page.request.get(BASE + '/api/session').json()
    try:
        response = audit.page.request.post(BASE + '/api/session/new', data={'cwd': str(workspace)})
        assert response.ok
        audit.page.goto(BASE, wait_until='domcontentloaded')
        for path in ['../outside/sentinel.md', 'linked-file.md', 'linked-directory/sentinel.md']:
            result = audit.invoke('session_export', {'path': path, 'confirm': True}, allow_writes=True)
            assert result['isError'], f'Export accepted forbidden path: {path}'
            assert sentinel.read_bytes() == expected, f'Outside sentinel changed: {path}'
            assert set(outside.iterdir()) == {sentinel}
            assert (workspace / 'linked-file.md').is_symlink()
            assert (workspace / 'linked-directory').is_symlink()
            print('export_path_rejected_and_outside_unchanged PASS', path, flush=True)
        result = audit.invoke('session_export', {'path': 'safe-export.md', 'confirm': False}, allow_writes=True)
        assert not result['isError']
        output = workspace / 'safe-export.md'
        content = output.read_bytes()
        assert content.startswith(b'# Pi Harness Session\n')
        assert audit.marker.encode() in content
        assert result['details']['workspace'] == str(workspace)
        assert result['details']['bytes'] == len(content)
        assert output.stat().st_mode & 0o777 == 0o600
        assert sentinel.read_bytes() == expected
        audit.panel('Session Export', ['safe-export.md', str(workspace)])
        audit.finish()
        print('actual_model_export_recovery PASS', flush=True)
    finally:
        try:
            response = audit.page.request.post(BASE + '/api/session/open', data={'path': original['sessionFile']})
            assert response.ok and response.json()['sessionId'] == original['sessionId']
            audit.page.goto(BASE, wait_until='domcontentloaded')
        finally:
            audit.close()
