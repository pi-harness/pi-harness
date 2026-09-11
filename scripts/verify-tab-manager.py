"""Use only a newly created audit session for real tab metadata operations."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['tab-manager'])
    target = None
    try:
        initial = audit.invoke('session_tab_manage', {'action': 'list'})
        assert not initial['isError']
        before = initial['details']['tabs']
        target = initial['details']['currentSessionPath']
        assert target and all(tab['sessionPath'] != target for tab in before)
        label = audit.marker + '_TAB'
        pin = audit.invoke('session_tab_manage', {'action': 'pin', 'label': label}, allow_writes=True)
        assert not pin['isError'] and pin['details']['sessionPath'] == target and pin['details']['pinned']
        audit.panel('Session Tabs', [label])
        renamed = label + '_RENAMED'
        result = audit.invoke('session_tab_manage', {'action': 'rename', 'label': renamed}, allow_writes=True)
        assert not result['isError']
        audit.panel('Session Tabs', [renamed])
        result = audit.invoke('session_tab_manage', {'action': 'unpin'}, allow_writes=True)
        assert not result['isError']
        own = next(tab for tab in result['details']['tabs'] if tab['sessionPath'] == target)
        assert own['pinned'] is False and own['label'] == renamed
        listed = audit.invoke('session_tab_manage', {'action': 'list'})
        assert not listed['isError'] and json.loads(listed['content'][0]['text']) == listed['details']
        assert next(tab for tab in listed['details']['tabs'] if tab['sessionPath'] == target) == own
        removed = audit.invoke('session_tab_manage', {'action': 'remove'}, allow_writes=True)
        assert not removed['isError'] and removed['details']['tabs'] == before
        assert Path(target).is_file(), 'Removing a tab deleted its journal'
        target = None
        audit.finish()
        print('tab_manager_metadata PASS', flush=True)
    finally:
        if target is not None:
            print('Incomplete audit: preserve its tab for diagnosis; no broad cleanup.', flush=True)
        audit.close()
