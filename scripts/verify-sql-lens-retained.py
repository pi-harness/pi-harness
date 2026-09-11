"""Recheck the actual retained long-TEXT result without another model call."""
import re
from playwright.sync_api import sync_playwright, expect

with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless=False,
    )
    try:
        page = browser.new_page(viewport={'width': 1440, 'height': 960})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
        page.goto('http://127.0.0.1:3144', wait_until='networkidle')
        page.get_by_role('button', name=re.compile(r'^插件，已安装')).click()
        page.get_by_role('button', name='查看 SQL Lens 详情', exact=True).click()
        expect(page.get_by_text('SQL Lens 面板数据异常', exact=True)).not_to_be_visible()
        expect(page.get_by_text('1 rows', exact=True)).to_be_visible()
        notice = page.get_by_text('面板显示 1 / 1 行；已迭代 1 行，行、列或单元格展示已截断。这不是匹配总行数。', exact=True)
        expect(notice).to_be_visible()
        expect(page.locator('pre').filter(has_text='"content"')).to_contain_text('x' * 16384 + '…')
        notice.scroll_into_view_if_needed()
        page.screenshot(path='/tmp/pih-sql-lens-long-text.png')
        assert not errors, errors
        print('retained_sql_long_text PASS; no model calls; no browser errors', flush=True)
    finally:
        browser.close()
