"""Real native bookmark persistence, cross-session search, and bounded export."""
from pathlib import Path
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

WORKTREE = Path('/Volumes/librefang/worktrees/plugin-functional-verification')
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['session-bookmarks', 'session-search', 'session-export'])
    try:
        result = audit.invoke('session_bookmarks', {'action': 'list'})
        assert not result['isError'] and result['details']['bookmarks'] == []
        original = audit.page.request.get(BASE + '/api/session').json()
        first_user = original['messages'][0]
        entry_id = next(e['id'] for e in original['entries'] if e.get('type') == 'message' and e['message']['role'] == 'user')
        label = 'Bookmark_' + audit.marker
        result = audit.invoke('session_bookmarks', {'action': 'add', 'entryId': entry_id, 'label': label}, allow_writes=True)
        assert not result['isError']
        assert result['details']['bookmarks'] == [{'id': entry_id, 'entryId': entry_id, 'label': label}]
        audit.panel('Session Bookmarks', ['1 个书签', label])
        title = audit.page.locator('button.session-row.active .session-copy strong').inner_text()
        audit.new_session()
        audit.panel('Session Bookmarks', ['还没有标记重要节点。'])
        result = audit.invoke('session_search', {'query': audit.marker})
        assert not result['isError']
        assert any(item['id'] == original['sessionId'] and item['hits'] for item in result['details']['items'])
        audit.panel('Session Search', [audit.marker])
        with audit.page.expect_response(lambda r: r.url.endswith('/api/session/open')) as opened:
            audit.page.locator('button.session-row').filter(has=audit.page.get_by_text(title, exact=True)).click()
        assert opened.value.ok
        assert audit.page.request.get(BASE + '/api/session').json()['sessionId'] == original['sessionId']
        result = audit.invoke('session_bookmarks', {'action': 'list'})
        assert not result['isError'] and result['details']['bookmarks'][0]['label'] == label
        result = audit.invoke('session_bookmarks', {'action': 'remove', 'bookmarkId': entry_id}, allow_writes=True)
        assert not result['isError'] and result['details']['bookmarks'] == []
        assert audit.messages()[0] == first_user
        audit.panel('Session Bookmarks', ['还没有标记重要节点。'])
        output = '.pi-harness/production-auth/exports/' + audit.marker + '.md'
        assert not (WORKTREE / output).exists(), 'The initial export must use a fresh test-only target'
        result = audit.invoke('session_export', {'path': output, 'confirm': False}, allow_writes=True)
        assert not result['isError']
        exported = (WORKTREE / output).read_bytes()
        assert len(exported) == result['details']['bytes']
        assert exported.startswith(b'# Pi Harness Session\n') and audit.marker.encode() in exported
        assert (WORKTREE / output).stat().st_mode & 0o777 == 0o600
        audit.panel('Session Export', [output])
        result = audit.invoke('session_export', {'path': output, 'confirm': False}, allow_writes=True)
        assert result['isError']
        assert (WORKTREE / output).read_bytes() == exported, 'Unconfirmed export must not overwrite existing bytes'
        result = audit.invoke('session_export', {'path': output, 'confirm': True}, allow_writes=True)
        assert not result['isError']
        replacement = (WORKTREE / output).read_bytes()
        assert len(replacement) == result['details']['bytes'] and len(replacement) > len(exported)
        assert (WORKTREE / output).stat().st_mode & 0o777 == 0o600
        audit.new_session()
        fresh = audit.page.request.get(BASE + '/api/session').json()
        assert fresh['sessionId'] != original['sessionId'] and not fresh['messages']
        audit.panel('Session Export', [output, original['sessionId'], str(WORKTREE)])
        audit.finish()
        print('native_bookmarks_search_export PASS', flush=True)
    except Exception as error:
        print('verification_failed', type(error).__name__, str(error), flush=True)
        raise
    finally:
        audit.close()
