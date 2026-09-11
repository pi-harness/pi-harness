"""Inspect real PNG/JPEG/GIF/WebP files through the live runtime and visible UI."""
from hashlib import sha256
from pathlib import Path
from tempfile import mkdtemp
import re
import sys
from PIL import Image
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

workspace = Path(__file__).resolve().parents[1]
# Sort early so bounded whole-workspace traversal reaches these fixtures first.
resume_catalog = '--retained-catalog' in sys.argv
folder = None
owns_folder = False
files = []
with sync_playwright() as p:
    audit = None
    try:
        catalog = None
        if resume_catalog:
            audit = LivePluginBrowser(p, ['vision-toolkit'], new_session=False)
            results = [message for message in audit.messages() if message.get('role') == 'toolResult' and message.get('toolName') == 'vision_catalog']
            assert len(results) == 1 and not results[0]['isError'], 'Expected exactly one retained successful audit catalog'
            catalog = results[0]
            folders = {asset['path'].split('/')[0] for asset in catalog['details']['assets']
                       if asset['path'].startswith('.000-vision-audit-')}
            assert len(folders) == 1
            name = folders.pop()
            assert re.fullmatch(r'\.000-vision-audit-[a-z0-9_]+', name)
            folder = workspace / name
            folder.mkdir()  # Refuse to reuse any pre-existing directory.
            owns_folder = True
        else:
            folder = Path(mkdtemp(prefix='.000-vision-audit-', dir=workspace))
            owns_folder = True
        expected = {}
        for index, (extension, format_name, mime) in enumerate([
            ('png', 'PNG', 'image/png'), ('jpg', 'JPEG', 'image/jpeg'),
            ('gif', 'GIF', 'image/gif'), ('webp', 'WEBP', 'image/webp'),
        ]):
            path = folder / f'素材😀.{extension}'
            files.append(path)
            size = (31 + index, 17 + index)
            Image.new('RGB', size, (12, 34, 56)).save(path, format=format_name)
            path.chmod(0o600)
            with Image.open(path) as decoded:
                decoded.load()
                assert decoded.size == size
            relative = path.relative_to(workspace).as_posix()
            expected[relative] = {'path': relative, 'mimeType': mime, 'bytes': path.stat().st_size,
                                  'width': size[0], 'height': size[1], 'headerTruncated': False}
        mismatched = folder / 'mismatched.jpg'
        files.append(mismatched)
        mismatched.write_bytes(files[0].read_bytes())
        mismatched.chmod(0o600)
        before = {path: sha256(path.read_bytes()).hexdigest() for path in files}
        if audit is None:
            audit = LivePluginBrowser(p, ['vision-toolkit'])
        if catalog is None:
            catalog = audit.invoke('vision_catalog', {})
        assert not catalog['isError']
        report = catalog['details']
        by_path = {asset['path']: asset for asset in report['assets']}
        text = catalog['content'][0]['text']
        for path, asset in expected.items():
            assert by_path[path] == asset
            assert path in text and asset['mimeType'] in text
        mismatch_path = mismatched.relative_to(workspace).as_posix()
        issue = next(issue for issue in report['issues'] if issue['path'] == mismatch_path)
        assert 'bytes do not match' in issue['reason']
        assert 'image issue' in text
        if report['truncated']:
            assert 'Catalog traversal was truncated' in text
        audit.panel('Vision Toolkit', ['视觉素材检查完成', *expected.keys(), f"{mismatch_path}: {issue['reason']}"])
        path = next(path for path in expected if path.endswith('.webp'))
        info = audit.invoke('vision_image_info', {'path': path})
        assert not info['isError'] and info['details'] == expected[path]
        assert path in info['content'][0]['text']
        audit.panel('Vision Toolkit', ['视觉素材检查完成', '34×20', path])
        rejected = audit.invoke('vision_image_info', {'path': mismatch_path})
        assert rejected['isError'] and 'bytes do not match' in rejected['content'][0]['text']
        audit.panel('Vision Toolkit', ['视觉素材检查失败', 'Image bytes do not match the jpeg file extension', '34×20'])
        audit.new_session()
        audit.panel('Vision Toolkit', ['等待检查', '让 Agent 调用 vision_catalog 盘点工作区图片，或调用 vision_image_info 检查单张图片。'])
        assert {path: sha256(path.read_bytes()).hexdigest() for path in files} == before
        audit.finish()
        print('vision_toolkit_four_formats_catalog_error_reset PASS', flush=True)
    finally:
        if audit is not None:
            audit.close()
        for path in files:
            path.unlink(missing_ok=True)
        if owns_folder:
            folder.rmdir()
