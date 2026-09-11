"""Real README generation and no-clobber writes to an owned test directory."""
import json
from pathlib import Path
from tempfile import mkdtemp
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

workspace = Path(__file__).resolve().parents[1]
folder = Path(mkdtemp(prefix='readme-audit-', dir=workspace / 'scripts/fixtures/plugin-verification'))
output = folder / 'README.audit.md'
relative = output.relative_to(workspace).as_posix()
manifest_bytes = (workspace / 'package.json').read_bytes()
manifest = json.loads(manifest_bytes)
original_readme = (workspace / 'README.md').read_bytes()
with sync_playwright() as p:
    audit = None
    try:
        audit = LivePluginBrowser(p, ['readme-gen'])
        result = audit.invoke('readme_report', {})
        assert not result['isError']
        report = result['details']
        assert report['name'] == manifest['name']
        assert report['version'] == manifest['version']
        assert report['scripts'] == sorted(manifest.get('scripts', {}))
        assert '@pi-harness/plugin-readme-gen' in report['plugins']
        assert result['content'][0]['text'] == report['markdown']
        audit.panel('README Gen', ['草稿已生成', manifest['name']])
        params = {'outputPath': relative, 'confirm': True}
        written = audit.invoke('readme_write', params, allow_writes=True)
        assert not written['isError']
        assert output.read_bytes() == report['markdown'].encode()
        assert written['details'] == {'path': relative, 'bytes': output.stat().st_size, 'overwritten': False}
        assert output.stat().st_mode & 0o777 == 0o600
        audit.panel('README Gen', ['写入已完成', relative])
        refused = audit.invoke('readme_write', params, allow_writes=True)
        assert refused['isError'] and 'overwrite=true' in refused['content'][0]['text']
        assert output.read_bytes() == report['markdown'].encode()
        audit.panel('README Gen', ['写入失败', relative])
        audit.new_session()
        audit.panel('README Gen', ['等待生成', '还没有生成 README 草稿。让 Agent 调用 readme_report 先检查内容。'])
        assert (workspace / 'package.json').read_bytes() == manifest_bytes
        assert (workspace / 'README.md').read_bytes() == original_readme
        audit.finish()
        print('readme_gen_report_write_no_clobber_reset PASS', flush=True)
    finally:
        if audit is not None:
            audit.close()
        output.unlink(missing_ok=True)
        folder.rmdir()
