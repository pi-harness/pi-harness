"""Compare synthetic persisted sessions through the real model in headed Chrome."""
import hashlib
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

WORKTREE = Path('/Volumes/librefang/worktrees/plugin-functional-verification')
fixtures = json.loads(subprocess.check_output(
    ['node', 'scripts/fixtures/plugin-verification/session-compare.mjs'], cwd=WORKTREE, text=True,
))
def digests():
    return {side: hashlib.sha256(Path(item['path']).read_bytes()).hexdigest() for side, item in fixtures.items()}

before = digests()
with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['session-compare'])
    try:
        result = audit.invoke('session_compare', {side: item['id'] for side, item in fixtures.items()})
        assert not result['isError']
        report = result['details']
        assert report['changed'] and report['shared'] == 1
        assert report['addedCount'] == report['removedCount'] == 1
        assert report['addedTruncated'] and report['removedTruncated']
        assert len(report['added'][0]['text']) == len(report['removed'][0]['text']) == 4000
        assert 'Difference previews are limited' in result['content'][0]['text']
        audit.panel('Session Compare', ['Session Compare Audit left', 'Session Compare Audit right',
                    '两个会话的文本消息在对应位置存在差异。',
                    '工具返回的差异预览已截断；上方计数仍为完整差异数量。',
                    '左侧差异预览（最多显示 4 条）', '右侧差异预览（最多显示 4 条）'])
        # Keep changed-result evidence before later panel checks replace the screenshot.
        Path('/tmp/pih-session-compare-changed.png').write_bytes(Path('/tmp/pih-session-compare.png').read_bytes())
        audit.page.get_by_role('button', name='插件，已安装', exact=False).click()
        audit.page.get_by_role('button', name='查看 Session Compare 详情', exact=True).click()
        previews = audit.page.locator('.plugin-panel-card li').filter(has_text='COMPARE_AUDIT_')
        assert previews.count() == 2
        layout = previews.evaluate_all('nodes => nodes.map(n => ({width:n.clientWidth, scroll:n.scrollWidth, card:n.closest(".plugin-panel-card").clientWidth, wrap:getComputedStyle(n).overflowWrap, whitespace:getComputedStyle(n).whiteSpace}))')
        print('preview_layout', layout, flush=True)
        assert all(item['scroll'] <= item['width'] + 1 and item['width'] <= item['card'] for item in layout), 'Long comparison previews overflow their cards'
        result = audit.invoke('session_compare', {'left': fixtures['left']['id'], 'right': fixtures['left']['id']})
        assert not result['isError'] and not result['details']['changed']
        assert result['details']['shared'] == 2
        assert not result['details']['addedTruncated'] and not result['details']['removedTruncated']
        audit.panel('Session Compare', ['两个会话的文本消息投影一致；未比较图片、工具调用参数及元数据。'])
        result = audit.invoke('session_compare', {'left': fixtures['left']['id'], 'right': audit.marker + '_missing'})
        assert result['isError']
        audit.panel('Session Compare', ['两个会话的文本消息投影一致；未比较图片、工具调用参数及元数据。'])
        audit.new_session()
        audit.panel('Session Compare', ['执行 session_compare 后显示两个会话的差异。'])
        assert digests() == before, 'Comparison must not modify either input session'
        audit.finish()
        print('session_compare PASS', flush=True)
    finally:
        audit.close()
