"""Real PNG files, independent pixel decoding, actual tool calls and visible panels."""
from hashlib import sha256
from pathlib import Path
from tempfile import mkdtemp
from PIL import Image, PngImagePlugin
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

workspace = Path(__file__).resolve().parents[1]
folder = Path(mkdtemp(prefix='image-audit-', dir=workspace / 'scripts/fixtures/plugin-verification'))
source = folder / '输入😀.png'
output = folder / '输入😀.min.png'
corrupt = folder / 'corrupt.png'
corrupt_output = folder / 'corrupt.min.png'
files = [source, output, corrupt, corrupt_output]
with sync_playwright() as p:
    audit = None
    try:
        original = Image.new('RGBA', (32, 32), (25, 125, 220, 128))
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text('Description', 'Synthetic image compressor audit')
        original.save(source, format='PNG', compress_level=0, pnginfo=metadata)
        source.chmod(0o600)
        input_bytes = source.read_bytes()
        damaged = bytearray(input_bytes)
        damaged[32] ^= 1  # IHDR CRC only: the plugin must not silently repair corruption.
        corrupt.write_bytes(damaged)
        corrupt.chmod(0o600)
        try:
            with Image.open(corrupt) as image:
                image.verify()
        except (OSError, SyntaxError):
            pass
        else:
            raise AssertionError('Independent PNG reader did not reject the corrupted fixture')
        audit = LivePluginBrowser(p, ['image-compressor'])
        path = source.relative_to(workspace).as_posix()
        result = audit.invoke('image_compress', {'path': path, 'confirm': False})
        assert result['isError'] and 'confirm=true' in result['content'][0]['text']
        assert not output.exists()
        result = audit.invoke('image_compress', {'path': path, 'confirm': True}, allow_writes=True)
        assert not result['isError']
        report = result['details']
        assert report['inputBytes'] == len(input_bytes)
        assert report['outputBytes'] == output.stat().st_size < len(input_bytes)
        assert report['savedBytes'] == len(input_bytes) - output.stat().st_size
        assert report['outputPath'] == output.relative_to(workspace).as_posix()
        assert output.stat().st_mode & 0o777 == 0o600
        with Image.open(output) as decoded:
            decoded.load()
            assert decoded.size == original.size
            assert decoded.convert('RGBA').tobytes() == original.tobytes()
            assert decoded.info['Description'] == 'Synthetic image compressor audit'
        summary = f"{path} → {report['outputPath']}，节省 {report['savedBytes']} bytes"
        audit.panel('Image Compressor', [summary])
        output_hash = sha256(output.read_bytes()).hexdigest()
        rejected = audit.invoke('image_compress', {'path': corrupt.relative_to(workspace).as_posix(), 'confirm': True}, allow_writes=True)
        assert rejected['isError'], 'Corrupted PNG was silently accepted and rewritten as a successful compression'
        assert 'CRC' in rejected['content'][0]['text']
        assert not corrupt_output.exists()
        assert source.read_bytes() == input_bytes
        assert corrupt.read_bytes() == damaged
        assert sha256(output.read_bytes()).hexdigest() == output_hash
        audit.panel('Image Compressor', [summary])
        audit.finish()
        print('image_compressor_pixels_metadata_corruption PASS', flush=True)
    finally:
        if audit is not None:
            audit.close()
        for path in files:
            path.unlink(missing_ok=True)
        folder.rmdir()
