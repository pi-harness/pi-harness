"""Exercise real structured cards, validation, retention, and layout in visible Chrome."""
import re
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import BASE, LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['genui', 'anchored-standard'])
    try:
        anchor = audit.invoke('trajectory_anchor_check', {})
        assert anchor['details']['violations'] == []
        assert anchor['details']['maxToolCalls'] == 64 and anchor['details']['allowedTools'] == []
        audit.panel('GenUI', ['还没有结构化卡片。可让 Agent 调用 genui_render。'])
        literal = '<script>window.__genuiAuditExecuted = true</script><img src=x onerror="window.__genuiAuditExecuted = true">'
        card = {'title': audit.marker + ' STATUS', 'blocks': [
            {'type': 'text', 'label': 'RAW_LITERAL', 'value': literal},
            {'type': 'badge', 'label': 'STATE', 'value': 'READY', 'tone': 'success'},
            {'type': 'progress', 'label': 'PROGRESS', 'value': '87.5', 'tone': 'info'},
        ]}
        result = audit.invoke('genui_render', card)
        assert not result['isError']
        assert result['details']['blocks'][0]['value'] == literal
        assert result['details']['blocks'][2]['value'] == 87.5
        audit.panel('GenUI', [card['title'], literal, 'READY', '87.5%'])
        assert audit.page.evaluate('window.__genuiAuditExecuted === undefined')
        for blocks in [
            [{'type': 'progress', 'label': '范围', 'value': '101'}],
            [{'type': 'text', 'label': '未知属性', 'value': 'test', 'extra': True}],
            [],
        ]:
            rejected = audit.invoke('genui_render', {'title': audit.marker, 'blocks': blocks})
            assert rejected['isError'], 'Invalid card must be rejected'
            audit.panel('GenUI', [card['title'], literal, '1 次'])
        audit.new_session()
        audit.panel('GenUI', [card['title'], '1 次'])
        long_value = ''.join(f'a{i:03d}' for i in range(525))
        long_card = {'title': audit.marker + ' 长文本', 'blocks': [
            {'type': 'text', 'label': '长文本验证', 'value': long_value},
        ]}
        long_result = audit.invoke('genui_render', long_card)
        assert not long_result['isError'] and long_result['details']['blocks'][0]['value'] == long_value
        audit.page.get_by_role('button', name=re.compile(r'^插件，已安装')).click()
        audit.page.get_by_role('button', name='查看 GenUI 详情', exact=True).click()
        panel = audit.page.locator('.plugin-panel-card').filter(has_text='GenUI')
        expect(panel.get_by_text(long_value[:2000], exact=True)).to_be_visible()
        expect(panel.get_by_text('面板明细已截断', exact=True)).to_be_visible()
        panel.scroll_into_view_if_needed()
        layout = panel.evaluate('card => ({width:card.clientWidth, scroll:card.scrollWidth})')
        audit.page.screenshot(path='/tmp/pih-genui-layout.png')
        print('genui_layout', layout, flush=True)
        assert layout['scroll'] <= layout['width'] + 1, 'GenUI long content overflows its panel'
        assert panel.locator('script, img').count() == 0
        assert audit.page.evaluate('window.__genuiAuditExecuted === undefined')
        audit.finish()
        print('genui PASS', flush=True)
    finally:
        audit.close()
