"""Real locale files: collision-safe differences, invalid roots, recovery and no writes."""
import hashlib
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

prefix = 'scripts/fixtures/plugin-verification/i18n-audit-'
files = [prefix + name + '.json' for name in ['base', 'target', 'invalid']]
before = {name: hashlib.sha256(Path(name).read_bytes()).hexdigest() for name in files}
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['i18n-pair'])
    try:
        result = audit.invoke('i18n_check', {'base': files[0], 'target': files[1]})
        assert not result['isError']
        report = result['details']
        assert report['baseKeys'] == 4 and report['targetKeys'] == 4
        assert set(report['missing']) == {'nested.missing', '["dotted.key"]'}
        assert set(report['extra']) == {'nested.extra', 'dotted.key'}
        model = json.loads(result['content'][0]['text'])
        assert model['missing'] == report['missing'] and model['extra'] == report['extra']
        assert not model['truncated']
        audit.panel('I18n Pair', ['缺失 2 个，额外 2 个。', 'nested.missing', '["dotted.key"]'])
        rejected = audit.invoke('i18n_check', {'base': files[0], 'target': files[2]})
        assert rejected['isError'] and 'Locale root must be a JSON object' in str(rejected['content'])
        audit.panel('I18n Pair', ['检查失败'])
        recovered = audit.invoke('i18n_check', {'base': files[0], 'target': files[0]})
        assert not recovered['isError'] and recovered['details']['missing'] == [] and recovered['details']['extra'] == []
        audit.panel('I18n Pair', ['语言包键完全一致。'])
        assert before == {name: hashlib.sha256(Path(name).read_bytes()).hexdigest() for name in files}
        audit.finish()
        print('i18n_pair_files_and_recovery PASS', flush=True)
    finally:
        audit.close()
