"""Actual bundled evidence engine with a public repository icon, no private image."""
from pathlib import Path
import argparse
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--cache', action='store_true', help='Verify repeat reads, reload, and session cache isolation')
options = parser.parse_args()

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['modlens'], new_session=False, wait_until='domcontentloaded')
    original = audit.page.request.get(BASE + '/api/session').json()
    assert original.get('sessionFile') and Path(original['sessionFile']).is_file()
    try:
        assert audit.page.request.post(BASE + '/api/session/new', data={'cwd': str(ROOT)}).ok
        audit.page.goto(BASE, wait_until='domcontentloaded')
        params = {'path': 'apps/web/public/icons/png-blue/pi-256.png', 'prompt': 'Describe the public icon shape and colors.'}
        result = audit.invoke('vision_inspect', params)
        panel = next(x['data'] for x in audit.page.request.get(BASE + '/api/plugin-ui').json()['items'] if x['id'] == 'modlens-panel')
        print('engine_status', panel['status']['state'], flush=True)
        if result['isError']:
            print('engine_error', panel['status'].get('error', '')[:2000], flush=True)
            assert panel['status']['state'] == 'failed'
            audit.panel('ModLens Vision Bridge', [panel['status']['error']])
            audit.finish()
            raise AssertionError('Actual bundled vision engine did not produce evidence')
        details = result['details']
        assert details['mode'] == 'evidence' and details['cached'] is False
        assert details['path'] == params['path']
        assert details['bytes'] == (ROOT / params['path']).stat().st_size
        assert details['evidence']['summary'].strip()
        assert panel['status']['state'] == 'completed'
        print('vision_summary', details['evidence']['summary'], flush=True)
        audit.panel('ModLens Vision Bridge', [params['path']])
        if options.cache:
            audit.page.goto(BASE, wait_until='domcontentloaded')
            cached = audit.invoke('vision_inspect', params)
            assert not cached['isError'] and cached['details']['cached'] is True
            assert cached['details']['evidence'] == details['evidence']
            panel = next(x['data'] for x in audit.page.request.get(BASE + '/api/plugin-ui').json()['items'] if x['id'] == 'modlens-panel')
            assert panel['image']['cached'] is True and panel['status']['state'] == 'completed'
            audit.panel('ModLens Vision Bridge', [params['path']])
            print('actual_cached_repeat_after_reload PASS', flush=True)
            assert audit.page.request.post(BASE + '/api/session/new', data={'cwd': str(ROOT)}).ok
            audit.page.goto(BASE, wait_until='domcontentloaded')
            panel = next(x['data'] for x in audit.page.request.get(BASE + '/api/plugin-ui').json()['items'] if x['id'] == 'modlens-panel')
            assert panel['image'] is None and panel['status']['state'] == 'idle'
            fresh = audit.invoke('vision_inspect', params)
            assert not fresh['isError'] and fresh['details']['cached'] is False
            assert fresh['details']['evidence']['summary'].strip()
            print('actual_new_session_cache_isolation PASS', flush=True)
        audit.finish()
        print('actual_bundled_evidence_engine PASS', flush=True)
    finally:
        try:
            restored = audit.page.request.post(BASE + '/api/session/open', data={'path': original['sessionFile']})
            assert restored.ok, f'Session restore HTTP {restored.status}'
            audit.page.goto(BASE, wait_until='domcontentloaded')
            assert audit.page.request.get(BASE + '/api/session').json()['sessionId'] == original['sessionId']
            print('original_session_restored PASS', flush=True)
        finally:
            audit.close()
