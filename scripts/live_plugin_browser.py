"""Shared real-model, real-plugin checks in an isolated visible browser."""
import json
import re
import time
from uuid import uuid4
from playwright.sync_api import expect

BASE = 'http://127.0.0.1:3144'

def wait_for_async_condition(page, expression, *, arg=None, timeout=30000):
    """Await each predicate result explicitly; a pending Promise is not success."""
    deadline = time.monotonic() + timeout / 1000
    while True:
        remaining = int((deadline - time.monotonic()) * 1000)
        if remaining <= 0:
            raise TimeoutError('Asynchronous browser condition did not become true')
        result = page.evaluate('''async ({expression, arg, remaining}) => {
            let timer;
            try {
                return await Promise.race([
                    Promise.resolve().then(() => (0, eval)('(' + expression + ')')(arg)),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error('Asynchronous browser condition timed out')), remaining);
                    }),
                ]);
            } finally { clearTimeout(timer); }
        }''', {'expression': expression, 'arg': arg, 'remaining': remaining})
        if result:
            return result
        remaining = int((deadline - time.monotonic()) * 1000)
        if remaining > 0:
            page.wait_for_timeout(min(100, remaining))

class LivePluginBrowser:
    def __init__(self, playwright, plugins, new_session=True, wait_until='networkidle'):
        self.browser = playwright.chromium.launch(
            executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless=False,
        )
        self.page = self.browser.new_page(viewport={'width': 1440, 'height': 960})
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.on('console', lambda message: self.errors.append(message.text) if message.type == 'error' else None)
        self.marker = 'PLUGIN_AUDIT_' + uuid4().hex[:8]
        self.page.goto(BASE, wait_until=wait_until)
        loaded = self.page.request.get(BASE + '/api/plugins').json()['items']
        for name in plugins:
            assert any(x['name'] == '@pi-harness/plugin-' + name and x['state'] == 'active' for x in loaded), name
        if new_session:
            self.new_session()

    def new_session(self):
        self.page.get_by_role('button', name='新建会话', exact=False).click()
        workspace = self.page.get_by_role('dialog').get_by_role('button').filter(has_text='plugin-functional-verification')
        with self.page.expect_response(lambda r: r.url.endswith('/api/session/new'), timeout=30000) as created:
            workspace.click()
        assert created.value.ok, f'New session failed: {created.value.status}'
        expect(self.page.get_by_role('dialog')).not_to_be_visible()
        expect(self.page.get_by_role('textbox', name='Prompt', exact=True)).to_be_visible()
        expect(self.page.locator('button.session-row.active small')).to_have_text(re.compile(r'^0 条消息'))

    def messages(self):
        # Only retry ECONNRESET on this idempotent observation, never prompts/writes.
        # Playwright's finite transport retry does not retry HTTP error responses.
        response = self.page.request.get(BASE + '/api/session', max_retries=2)
        assert response.ok, f'Session read failed: {response.status}'
        return response.json()['messages']

    def invoke(self, tool, params, allow_writes=False, retained_history=False):
        if not self.page.get_by_role('textbox', name='Prompt', exact=True).is_visible():
            self.page.locator('button.session-row.active').click()
            expect(self.page.get_by_role('textbox', name='Prompt', exact=True)).to_be_visible()
        before = len(self.messages())
        if retained_history:
            initial = self.page.request.get(BASE + '/api/session').json()
            before_ids = {entry['id'] for entry in initial['entries']}
        self.page.get_by_role('textbox', name='Prompt', exact=True).fill(
            f'{self.marker} 插件验证：只调用一次 {tool}，参数严格为 {json.dumps(params)}。'
            '这是独立测试步骤；即使之前调用过相同参数，本轮也必须实际调用一次，不可用历史结果代替。'
            '不得添加或删除任何参数键；空对象也必须原样保留。不要调用其他工具或安装依赖。'
            + ('仅允许本次工具指定的测试会话或测试导出文件写入。' if allow_writes else '不要修改文件。')
            + '返回后仅回复：验证完成。即使工具错误也不要重试。'
        )
        with self.page.expect_response(lambda r: r.url.endswith('/api/prompt'), timeout=180000) as pending:
            self.page.get_by_role('button', name='发送消息', exact=True).click()
        assert pending.value.ok, f'Prompt failed: {pending.value.status}'
        # /api/prompt can resolve immediately after the assistant text is
        # appended while the runtime status and streaming DOM settle on the
        # next refresh tick. Wait on those conditions instead of racing the
        # rendered reply assertion.
        wait_for_async_condition(self.page,
            """async () => {
              const response = await fetch('/api/status');
              if (!response.ok) return false;
              const status = await response.json();
              return status.status === 'ready' && !document.querySelector('.streaming-turn');
            }""",
            timeout=180000,
        )
        # The endpoint awaits runtime.prompt. Branch navigation can remove this
        # invocation from current messages while retaining it in native entries.
        if retained_history:
            snapshot = self.page.request.get(BASE + '/api/session').json()
            assert snapshot['sessionId'] == initial['sessionId'], 'Unexpected session replacement'
            messages = [entry['message'] for entry in snapshot['entries']
                        if entry['id'] not in before_ids and entry.get('type') == 'message']
        else:
            messages = self.messages()[before:]
        calls = [part for m in messages for part in m.get('content', [])
                 if isinstance(part, dict) and part.get('type') == 'toolCall']
        assert len(calls) == 1 and calls[0]['name'] == tool, [c['name'] for c in calls]
        assert calls[0]['arguments'] == params, f'{tool}: model did not preserve the requested parameters'
        results = [m for m in messages if m.get('role') == 'toolResult']
        assert len(results) == 1 and results[0]['toolName'] == tool
        assert results[0]['toolCallId'] == calls[0]['id']
        expect(self.page.locator('.turn.text:not(.streaming-turn)').last).to_be_visible()
        print(tool, {'isError': results[0]['isError']}, flush=True)
        return results[0]

    def panel(self, title, texts):
        self.page.get_by_role('button', name=re.compile(r'^插件，已安装')).click()
        self.page.get_by_role('button', name=f'查看 {title} 详情', exact=True).click()
        for text in texts:
            expect(self.page.get_by_text(text, exact=True).first).to_be_visible()
        self.page.get_by_text(texts[-1], exact=True).first.scroll_into_view_if_needed()
        self.page.screenshot(path='/tmp/pih-' + title.lower().replace(' ', '-') + '.png')
        print(title + ' panel PASS', flush=True)
        self.page.locator('button.session-row.active').click()
        expect(self.page.get_by_role('textbox', name='Prompt', exact=True)).to_be_visible()

    def finish(self):
        assert not self.errors, self.errors
        print('no_browser_errors PASS', flush=True)

    def close(self):
        self.browser.close()
