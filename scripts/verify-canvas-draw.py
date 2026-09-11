"""Exercise actual Canvas Draw calls and visible source panels, without file writes."""
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['canvas-draw'])
    try:
        # Start a fresh chat to avoid mixing messages; the live plugin panel
        # may retain its last rendered diagram across sessions, so don't make
        # an empty-state assertion here.
        audit.new_session()
        audit.panel('Canvas Draw', ['将结构化节点和边转换为可复制的 Mermaid 流程图源码。'])
        params = {
            'direction': 'LR',
            'nodes': [
                {'id': 'end', 'label': '开始😀 <b> & "测试"'},
                {'id': 'canvas_node_0', 'label': '结束'},
            ],
            'edges': [{'from': 'end', 'to': 'canvas_node_0', 'label': '通过 | #quot;'}],
        }
        source = ('flowchart LR\n'
                  '    canvas_node_0["开始😀 &lt;b&gt; &amp; &quot;测试&quot;"]\n'
                  '    canvas_node_1["结束"]\n'
                  '    canvas_node_0 -->|"通过 #124; #35;quot;"| canvas_node_1')
        result = audit.invoke('canvas_draw', params)
        assert not result['isError']
        assert result['content'][0]['text'] == source
        assert result['details'] == {**params, 'nodeCount': 2, 'edgeCount': 1, 'mermaid': source}
        audit.panel('Canvas Draw', ['2 节点 · 1 连线', source])
        for invalid, error in [
            ({'nodes': [{'id': 'a', 'label': 'A'}], 'edges': [{'from': 'a', 'to': 'missing'}]}, 'unknown node'),
            ({'nodes': [{'id': 'a', 'label': 'A'}, {'id': 'a', 'label': 'B'}], 'edges': []}, 'Duplicate node id'),
        ]:
            result = audit.invoke('canvas_draw', invalid)
            assert result['isError']
            assert error in result['content'][0]['text']
            audit.panel('Canvas Draw', ['2 节点 · 1 连线', source])
        audit.new_session()
        audit.panel('Canvas Draw', ['2 节点 · 1 连线', source])
        audit.finish()
        print('canvas_draw_source_validation_retention PASS', flush=True)
    finally:
        audit.close()
