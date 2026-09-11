"""Exercise only uniquely labelled audit nodes through the actual model/browser."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

STORE = Path('/Volumes/librefang/worktrees/plugin-functional-verification/.pih-agent/production-audit-graph-memory.json')
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['graph-memory'])
    created = []
    try:
        # Dedicated store, never delete or rewrite a pre-existing graph to prepare a test.
        if STORE.exists():
            stored = json.loads(STORE.read_text())
            assert not stored['nodes'] and not stored['relations'], 'Graph audit requires an empty dedicated store'
        labels = [audit.marker + '_task', audit.marker + '_skill']
        for kind, label in zip(['task', 'skill'], labels):
            result = audit.invoke('graph_memory_record', {'kind': kind, 'label': label, 'summary': 'Synthetic graph audit', 'source': 'audit://graph/' + kind}, allow_writes=True)
            assert not result['isError']
            created.append(result['details']['id'])
        assert STORE.stat().st_mode & 0o777 == 0o600
        link = {'from': created[0], 'to': created[1], 'relation': 'USED_SKILL'}
        result = audit.invoke('graph_memory_link', link, allow_writes=True)
        assert not result['isError']
        relation_id = result['details']['id']
        result = audit.invoke('graph_memory_link', link, allow_writes=True)
        assert not result['isError'] and result['details']['id'] == relation_id
        audit.new_session()
        result = audit.invoke('graph_memory_search', {'query': audit.marker, 'limit': 1})
        assert not result['isError'] and result['details']['total'] == 2
        assert len(result['details']['nodes']) == 1 and result['details']['relations'][0]['id'] == relation_id
        text = result['content'][0]['text']
        report = json.loads(text)
        assert report == result['details']
        assert report['nodes'][0]['source'].startswith('audit://graph/')
        assert report['relations'][0]['relation'] == 'USED_SKILL'
        assert report['total'] == 2 and report['nodesTruncated'] and report['nextOffset'] == 1
        assert len(text.encode('utf8')) <= 128 * 1024
        audit.panel('Graph Memory', [labels[0], labels[1], '2 节点 · 1 关系', '1 / 2'])
        next_page = audit.invoke('graph_memory_search', {'query': audit.marker, 'limit': 1, 'offset': report['nextOffset']})
        assert not next_page['isError'] and next_page['details']['nextOffset'] is None
        assert next_page['details']['nodes'][0]['id'] != report['nodes'][0]['id']
        result = audit.invoke('graph_memory_search', {'query': 'P'})
        assert not result['isError'] and result['details']['total'] == 2
        before = STORE.read_bytes()
        result = audit.invoke('graph_memory_forget', {'id': created[0], 'confirm': False}, allow_writes=True)
        assert result['isError'] and STORE.read_bytes() == before
        result = audit.invoke('graph_memory_forget', {'id': created[0], 'confirm': True}, allow_writes=True)
        assert not result['isError'] and result['details']['removedRelations'] == 1
        created.pop(0)
        result = audit.invoke('graph_memory_forget', {'id': created[0], 'confirm': True}, allow_writes=True)
        assert not result['isError']
        created.pop(0)
        stored = json.loads(STORE.read_text())
        assert not stored['nodes'] and not stored['relations']
        assert not Path(str(STORE) + '.lock').exists()
        audit.panel('Graph Memory', ['尚未记录图记忆。Agent 可调用 graph_memory_record 创建任务、技能或事件节点。'])
        audit.finish()
    finally:
        try:
            for node_id in created:
                try:
                    cleanup = audit.invoke('graph_memory_forget', {'id': node_id, 'confirm': True}, allow_writes=True)
                    assert not cleanup['isError']
                except Exception as error:
                    print('Scoped graph cleanup failed:', type(error).__name__, flush=True)
        finally:
            audit.close()
