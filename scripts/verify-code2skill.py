"""Real skill publication and overwrite refusal; clean only this run's exact pack."""
import json
import stat
from pathlib import Path
from uuid import uuid4
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import LivePluginBrowser

source = Path('scripts/fixtures/plugin-verification/i18n-audit-base.json')
original = source.read_bytes()
slug = 'pih-code2skill-audit-' + uuid4().hex[:10]
pack = Path('.pi/skills') / slug
assert not pack.exists()
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['code2skill'])
    created = False
    try:
        expect(audit.page.locator('.provider-auth-notice')).not_to_be_visible()
        params = {'name': slug, 'description': 'Explicit-only inert verification fixture, no operational instructions.', 'files': [str(source)]}
        result = audit.invoke('skill_pack_create', params, allow_writes=True)
        assert not result['isError']
        created = True
        report = result['details']
        assert json.loads(result['content'][0]['text']) == report
        assert report == {'slug': slug, 'directory': str(pack), 'files': [{'path': str(source), 'bytes': len(original)}], 'bytes': len(original)}
        manifest = pack / 'SKILL.md'
        reference = pack / 'references' / source
        assert not pack.is_symlink() and not manifest.is_symlink() and not reference.is_symlink()
        assert reference.read_bytes() == original
        manifest_bytes = manifest.read_bytes()
        assert ('name: ' + slug).encode() in manifest_bytes
        assert ('references/' + str(source)).encode() in manifest_bytes
        assert stat.S_IMODE(manifest.stat().st_mode) == 0o600
        assert stat.S_IMODE(reference.stat().st_mode) == 0o600
        audit.panel('Code2Skill', [slug + ' · 1 个参考文件'])
        refused = audit.invoke('skill_pack_create', params, allow_writes=True)
        assert refused['isError'] and 'already exists' in str(refused['content'])
        assert manifest.read_bytes() == manifest_bytes and reference.read_bytes() == original
        assert source.read_bytes() == original
        audit.new_session()
        audit.panel('Code2Skill', ['还没有生成技能。可让 Agent 调用 skill_pack_create。'])
        audit.finish()
        print('code2skill_publication_and_refusal PASS', flush=True)
    finally:
        try:
            if created:
                # Explicit known outputs only; nonrecursive rmdir refuses unexpected contents.
                (pack / 'references' / source).unlink()
                (pack / 'SKILL.md').unlink()
                directory = (pack / 'references' / source).parent
                while directory != pack.parent:
                    directory.rmdir()
                    directory = directory.parent
                print('own_generated_pack_removed PASS', flush=True)
        finally:
            audit.close()
