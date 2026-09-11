"""Verify missing-auth UX on the local source runtime without credentials."""
from playwright.sync_api import sync_playwright, expect

with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        headless=False,
    )
    page = browser.new_page(viewport={"width": 1440, "height": 960})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("http://127.0.0.1:3143", wait_until="networkidle")
    notice = page.locator(".provider-auth-notice")
    expect(notice).to_be_visible()
    expect(notice).to_contain_text("模型尚未配置认证")
    prompt = page.get_by_role("textbox", name="Prompt", exact=True)
    original = "AUTH_READINESS_DRAFT_TEST：不要调用任何工具。"
    prompt.fill(original)
    with page.expect_response(lambda response: response.url.endswith("/api/prompt")) as pending:
        page.get_by_role("button", name="发送消息", exact=True).click()
    assert pending.value.status == 400
    expect(prompt).to_have_value(original)
    # Control only the HTTP failure timing to cover typing during a pending send.
    # The previous rejection above went through the actual unauthenticated server.
    replacement = "NEW_DRAFT_MUST_SURVIVE"
    def reject_after_new_draft(route):
        prompt.fill(replacement)
        route.fulfill(status=400, json={"error": "Synthetic rejected request for draft retention regression"})
    page.route("**/api/prompt", reject_after_new_draft)
    with page.expect_response(lambda response: response.url.endswith("/api/prompt")):
        page.get_by_role("button", name="发送消息", exact=True).click()
    expect(page.get_by_role("alert")).to_contain_text("Synthetic rejected request")
    expect(prompt).to_have_value(replacement)
    notice.get_by_role("button", name="提供商", exact=True).click()
    expect(page.get_by_text("已启用提供商 · /api/providers", exact=True)).to_be_visible()
    assert not errors, errors
    print("missing auth shown before submit; rejected draft retained; settings reachable PASS")
    browser.close()
