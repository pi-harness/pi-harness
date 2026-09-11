"""Real annotation collection, retrieval and prompt generation in headed Chrome."""
import json
from playwright.sync_api import sync_playwright
from live_plugin_browser import BASE, LivePluginBrowser

def collection(audit):
    return next(x['data']['annotations'] for x in audit.page.request.get(BASE + '/api/plugin-ui').json()['items'] if x['id'] == 'annotation-panel')

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['annotation'])
    failure = None
    try:
        assert collection(audit) == [], 'requires a clean isolated plugin instance; refusing to clear existing annotations'
        quote = audit.marker + ' first quoted passage'
        note = 'Keep this distinction'
        result = audit.invoke('annotation_manage', {'action': 'add', 'quote': quote, 'note': note})
        assert not result['isError'] and result['details']['quote'] == quote
        annotation_id = result['details']['id']
        audit.panel('Annotations', [quote, note])
        result = audit.invoke('annotation_manage', {'action': 'list'})
        assert not result['isError'] and any(x['id'] == annotation_id for x in result['details']['annotations'])
        readable = any(quote in x.get('text', '') and note in x.get('text', '') for x in result['content'])
        print('model_can_read_collected_annotations', readable, flush=True)
        result = audit.invoke('annotation_manage', {'action': 'add', 'quote': audit.marker + ' second passage', 'note': 'Second note'})
        assert not result['isError']
        second_id = result['details']['id']
        result = audit.invoke('annotation_manage', {'action': 'list', 'offset': 0, 'limit': 1})
        page = json.loads(result['content'][0]['text'])
        assert page['returned'] == 1 and page['nextOffset'] == 1 and page['annotations'][0]['id'] == annotation_id
        result = audit.invoke('annotation_manage', {'action': 'list', 'offset': page['nextOffset'], 'limit': 1})
        page = json.loads(result['content'][0]['text'])
        assert page['returned'] == 1 and page['nextOffset'] is None and page['annotations'][0]['id'] == second_id
        audit.new_session()
        result = audit.invoke('annotation_manage', {'action': 'list'})
        assert [x['id'] for x in result['details']['annotations']] == [annotation_id, second_id]
        result = audit.invoke('annotation_manage', {'action': 'prompt', 'question': 'Explain the quoted distinction.'})
        assert not result['isError'] and quote in result['content'][0]['text'] and note in result['content'][0]['text']
        audit.panel('Annotations', ['最近生成的提问上下文'])
        result = audit.invoke('annotation_manage', {'action': 'remove', 'id': annotation_id})
        assert not result['isError'] and not any(x['id'] == annotation_id for x in result['details']['annotations'])
        assert all(x['quote'].startswith(audit.marker) for x in collection(audit)), 'refusing to clear annotations owned by another client'
        result = audit.invoke('annotation_manage', {'action': 'clear'})
        assert not result['isError'] and result['details']['count'] == 0
        audit.panel('Annotations', ['尚未收集批注。Agent 可调用 annotation_manage 的 add 操作记录回复片段。'])
        audit.finish()
        assert readable, 'list returned only a count, so the model cannot inspect collected annotations'
    except BaseException as error:
        failure = error
        raise
    finally:
        try:
            for item in collection(audit):
                if item['quote'].startswith(audit.marker):
                    result = audit.invoke('annotation_manage', {'action': 'remove', 'id': item['id']})
                    assert not result['isError'], 'failed to clean up this test annotation'
        except Exception as cleanup_error:
            if failure is None:
                raise
            failure.add_note('Test annotation cleanup failed: ' + type(cleanup_error).__name__)
        finally:
            audit.close()
