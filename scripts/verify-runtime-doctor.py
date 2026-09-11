"""Exercise the source-loaded doctor in an isolated visible browser."""
import re
from playwright.sync_api import sync_playwright, expect

with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless=False,
    )
    page = browser.new_page(viewport={'width': 1440, 'height': 960})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://127.0.0.1:3144', wait_until='networkidle')
    page.get_by_role('button', name=re.compile(r'^插件，已安装')).click()
    page.get_by_role('button', name='查看 Runtime Doctor 详情', exact=True).click()
    expect(page.get_by_text('运行时服务已注册（未探测模型请求）', exact=True)).to_be_visible()
    page.screenshot(path='/tmp/pih-runtime-doctor-panel.png')
    print('real_plugin_panel PASS', flush=True)
    page.get_by_role('button', name='新建会话', exact=False).click()
    page.get_by_role('dialog').get_by_role('button').filter(has_text='plugin-functional-verification').click()
    page.get_by_role('textbox', name='Prompt', exact=True).fill(
        '请只调用一次 runtime_doctor 工具，参数为空对象，不调用其他工具。然后用一句话汇报检查结果。'
    )
    with page.expect_response(lambda r: r.url.endswith('/api/prompt'), timeout=180000) as pending:
        page.get_by_role('button', name='发送消息', exact=True).click()
    response = pending.value
    print('prompt_status', response.status, flush=True)
    assert response.ok
    messages = page.request.get('http://127.0.0.1:3144/api/session').json()['messages']
    calls = [part for message in messages for part in message.get('content', [])
             if isinstance(part, dict) and part.get('type') == 'toolCall']
    assert len(calls) == 1 and calls[0]['name'] == 'runtime_doctor'
    results = [message for message in messages if message.get('role') == 'toolResult']
    assert len(results) == 1 and results[0]['toolName'] == 'runtime_doctor'
    assert results[0]['isError'] is False
    assert len(results[0]['details']['checks']) == 6
    print('single_real_tool_call_and_six_checks PASS', flush=True)
    expect(page.locator('.turn.text:not(.streaming-turn)').last).to_be_visible()
    page.screenshot(path='/tmp/pih-runtime-doctor-result.png')
    print('page_errors', errors, flush=True)
    assert not errors
    browser.close()
