"""Real persistent memory operations, restricted to this run's unique key."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

STORE = Path('/Volumes/librefang/worktrees/plugin-functional-verification/.pih-agent/production-audit-memory.json')
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['memory'])
    key = audit.marker + '_fact'
    saved = False
    try:
        original = {m['key']: m for m in json.loads(STORE.read_text())['memories']} if STORE.exists() else {}
        assert key not in original
        assert len(original) < 500, 'Refuse a test write that could evict existing memories'
        saved = True
        result = audit.invoke('memory_set', {'key': key, 'value': 'Audit preference: use TypeScript.', 'tags': ['audit']}, allow_writes=True)
        assert not result['isError']
        identity = result['details']['id']
        assert STORE.stat().st_mode & 0o777 == 0o600
        assert not Path(str(STORE) + '.lock').exists()
        audit.panel('Memory', [key, 'Audit preference: use TypeScript.'])
        result = audit.invoke('memory_set', {'key': key, 'value': 'Audit preference: use Rust instead.', 'tags': ['audit', 'updated']}, allow_writes=True)
        assert not result['isError'] and result['details']['id'] == identity
        audit.new_session()
        result = audit.invoke('memory_search', {'query': key})
        assert not result['isError'] and result['details']['total'] == 1
        assert result['details']['memories'][0]['value'] == 'Audit preference: use Rust instead.'
        assert 'Audit preference: use Rust instead.' in result['content'][0]['text']
        audit.panel('Memory', [key, 'Audit preference: use Rust instead.'])
        result = audit.invoke('memory_search', {'query': 'R'})
        assert not result['isError'] and any(m['key'] == key for m in result['details']['memories'])
        before = STORE.read_bytes()
        result = audit.invoke('memory_delete', {'key': key, 'confirm': False}, allow_writes=True)
        assert result['isError'] and STORE.read_bytes() == before
        result = audit.invoke('memory_delete', {'key': key, 'confirm': True}, allow_writes=True)
        assert not result['isError'] and result['details']['removed']
        saved = False
        result = audit.invoke('memory_search', {'query': key})
        assert not result['isError'] and result['details']['total'] == 0
        result = audit.invoke('memory_delete', {'key': key, 'confirm': True}, allow_writes=True)
        assert not result['isError'] and not result['details']['removed']
        current = {m['key']: m for m in json.loads(STORE.read_text())['memories']}
        assert all(current.get(k) == v for k, v in original.items()), 'Unrelated memories changed'
        assert key not in current and not Path(str(STORE) + '.lock').exists()
        if not current:
            audit.panel('Memory', ['尚未保存记忆。Agent 可调用 memory_set 明确写入。'])
        audit.finish()
        print('memory_persistence_update_delete PASS', flush=True)
    finally:
        try:
            if saved:
                # No broad clear or direct file rewrite; remove only our unique test key.
                try:
                    cleanup = audit.invoke('memory_delete', {'key': key, 'confirm': True}, allow_writes=True)
                    assert not cleanup['isError']
                except Exception as cleanup_error:
                    print('Scoped test-key cleanup failed:', type(cleanup_error).__name__, flush=True)
        finally:
            audit.close()
