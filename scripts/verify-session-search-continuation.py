"""Verify real model continuation finds an existing audit journal beyond page one."""
import hashlib
import json
import os
import re
from pathlib import Path
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / '.pih-agent' / 'sessions'

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['session-search'])
    try:
        # Read only prior synthetic audit journals. Do not edit/create history
        # fixtures or emit private journal contents. Discover actual directory
        # order instead of assuming newest-first or lexical ordering.
        with os.scandir(DIRECTORY) as entries:
            candidates = [Path(entry.path) for entry in entries
                          if entry.name.endswith('.jsonl') and entry.is_file(follow_symlinks=False)]
        target = None
        for path in candidates[205:]:
            raw = path.read_bytes()
            if len(raw) > 4 * 1024 * 1024:
                continue
            try:
                rows = [json.loads(line) for line in raw.decode('utf-8').splitlines() if line.strip()]
            except (UnicodeError, ValueError):
                continue
            if not rows or rows[0].get('cwd') != str(ROOT):
                continue
            for row in rows:
                message = row.get('message', {})
                content = message.get('content')
                if isinstance(content, list):
                    content = '\n'.join(part['text'] for part in content
                                        if isinstance(part, dict) and part.get('type') == 'text' and isinstance(part.get('text'), str))
                if message.get('role') != 'user' or not isinstance(content, str):
                    continue
                match = re.match(r'(PLUGIN_AUDIT_[a-f0-9]{8}) 插件验证', content)
                if match:
                    target = (path, match.group(1), hashlib.sha256(raw).hexdigest())
                    break
            if target:
                break
        assert target, 'Need a prior synthetic audit journal beyond the first 205 candidates'
        path, query, digest = target
        cursor = None
        found = []
        counts = []
        for page_number in range(10):
            params = {'query': query}
            if cursor is not None:
                params['cursor'] = cursor
            result = audit.invoke('session_search', params)
            assert not result['isError'], 'Search or continuation returned a tool error'
            report = result['details']
            text = ''.join(part['text'] for part in result['content'] if part.get('type') == 'text')
            assert json.loads(text) == report, 'Model-visible page must equal full report'
            assert report['scanned'] + report['skipped'] <= 200
            assert report['byteBudgetUsed'] <= 32 * 1024 * 1024
            assert report['total'] == len(report['items']) <= 100
            page_paths = [item['path'] for item in report['items']]
            if page_number == 0:
                assert str(path) not in page_paths, 'Target must really be beyond first-page coverage'
                assert isinstance(report['nextCursor'], str), 'Partial scan needs a continuation'
            found.extend(page_paths)
            counts.append(report['scanned'])
            cursor = report['nextCursor']
            if cursor is None:
                break
        assert cursor is None, 'Search did not exhaust within ten bounded pages'
        assert str(path) in found, 'Continuation still missed the known matching tail journal'
        assert len(found) == len(set(found)), 'Continuation returned duplicate journals'
        assert hashlib.sha256(path.read_bytes()).hexdigest() == digest, 'Search modified target history'
        panels = audit.page.request.get(BASE + '/api/plugin-ui').json()['items']
        panel = next(item for item in panels if item['id'] == 'session-search-panel')
        assert panel['data'] == report, 'Panel must expose the latest completed page'
        audit.panel('Session Search', [query])
        audit.finish()
        print('session_search_tail_continuation PASS', {'pages': len(counts), 'scanned': sum(counts)}, flush=True)
    finally:
        audit.close()
