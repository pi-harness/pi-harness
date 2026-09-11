"""Check retained real GitHub search layout without a model call or session reset."""
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser
import sys

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['plugin-radar'], new_session=False)
    try:
        if '--metadata' in sys.argv:
            audit.panel('Plugin Radar', ['只读搜索 GitHub 上带 Pi Harness Topic 的仓库，按 Star 排序；候选仓库未验证可安装性，不会安装或执行代码。', 'GitHub Topic 搜索'])
            print('plugin_radar_marketplace_metadata PASS', flush=True)
        else:
            audit.panel('Plugin Radar', ['GitHub Pi Harness 生态'])
            audit.page.get_by_role('button', name='插件，已安装', exact=False).click()
            audit.page.get_by_role('button', name='查看 Plugin Radar 详情', exact=True).click()
            card = audit.page.locator('.plugin-panel-card').filter(has_text='GitHub Pi Harness 生态')
            assert card.locator('ol li').count() > 0, 'Need retained actual repository rows'
            widths = card.evaluate('(el) => ({width: el.clientWidth, scroll: el.scrollWidth})')
            assert widths['scroll'] <= widths['width'] + 1, widths
            audit.page.screenshot(path='/tmp/pih-plugin-radar-layout.png')
            print('plugin_radar_retained_layout PASS', widths, flush=True)
        audit.finish()
    finally:
        audit.close()
