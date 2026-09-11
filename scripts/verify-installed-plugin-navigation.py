"""Visit every installed plugin detail in headed Chrome; no tool/model calls."""
import re
import argparse
from playwright.sync_api import sync_playwright, expect
from live_plugin_browser import LivePluginBrowser

parser = argparse.ArgumentParser()
parser.add_argument('--reload', action='store_true', help='Reload each opened detail and verify route restoration')
parser.add_argument('--widths', type=int, nargs='+', default=[1440, 760], help='Viewport widths to verify')
args = parser.parse_args()

with sync_playwright() as p:
    audit = LivePluginBrowser(p, [], new_session=False, wait_until='domcontentloaded')
    try:
        page = audit.page
        entry = page.get_by_role('button', name=re.compile(r'^插件，已安装'))
        expect(entry).to_be_visible()
        entry.click()
        buttons = page.get_by_role('button', name=re.compile(r'^查看 .+ 详情$'))
        expect(buttons.first).to_be_visible()
        expected = int(re.search(r'已安装 (\d+) 个', entry.get_attribute('aria-label')).group(1))
        expect(buttons).to_have_count(expected)
        names = [buttons.nth(i).get_attribute('aria-label') for i in range(expected)]
        assert len(set(names)) == expected and expected > 0
        for width in args.widths:
            page.set_viewport_size({'width': width, 'height': 960})
            for index, name in enumerate(names):
                page.get_by_role('button', name=name, exact=True).click()
                detail = page.locator('.plugin-detail-content')
                expect(detail.locator('h1')).to_have_text(name[3:-3])
                if args.reload:
                    route = page.url
                    page.reload(wait_until='domcontentloaded')
                    expect(detail.locator('h1')).to_have_text(name[3:-3])
                    expect(page).to_have_url(route)
                expect(detail).to_be_visible()
                expect(detail.get_by_text(re.compile('面板数据异常'))).to_have_count(0)
                overflow = detail.evaluate('''el => {
                  const failures = [];
                  for(let node=el; node; node=node.parentElement)
                    if(node.scrollWidth > node.clientWidth + 1)
                      failures.push({class: node.className, width: node.clientWidth, scroll: node.scrollWidth});
                  return failures;
                }''')
                if overflow:
                    page.screenshot(path='/tmp/pih-plugin-navigation-overflow.png')
                assert not overflow, f'Overflow at {width}: {name}: {overflow}'
                if index == len(names) - 1:
                    page.screenshot(path=f'/tmp/pih-plugin-navigation-{width}.png')
                page.get_by_role('link', name='← 已安装插件', exact=True).click()
                expect(buttons).to_have_count(expected)
                if (index + 1) % 20 == 0:
                    print(f'visited {index + 1}/{expected} at {width}px', flush=True)
            print(f'all {expected} installed details navigable at {width}px PASS; reload={args.reload}', flush=True)
        audit.finish()
    finally:
        audit.close()
