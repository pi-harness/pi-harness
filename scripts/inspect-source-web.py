"""Inspect only our local source runtime in an isolated browser profile."""
import argparse
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument("--url", default="http://127.0.0.1:3143")
parser.add_argument("--headed", action="store_true")
parser.add_argument("--prompt-check", action="store_true")
args = parser.parse_args()

with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        headless=not args.headed,
    )
    page = browser.new_page(viewport={"width": 1440, "height": 960})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(args.url, wait_until="networkidle")
    page.wait_for_function("document.querySelectorAll('button').length > 5")
    print("title", page.title(), flush=True)
    # Session-title buttons can contain private prompt text; never dump them.
    print("button_count", page.locator("button").count(), flush=True)
    print("inputs", page.locator("textarea,input").evaluate_all(
        "nodes => nodes.map(n => ({tag:n.tagName,placeholder:n.getAttribute('placeholder'),label:n.getAttribute('aria-label')}))"
    ), flush=True)
    page.screenshot(path="/tmp/pih-source-web.png", full_page=True)
    if args.prompt_check:
        page.get_by_role("textbox", name="Prompt", exact=True).fill("请仅回复 SOURCE_RUNTIME_OK，不调用任何工具。")
        with page.expect_response(lambda response: response.url.endswith("/api/prompt"), timeout=60000) as pending:
            page.get_by_role("button", name="发送消息", exact=True).click()
        response = pending.value
        result = response.json()
        print("prompt_response", {"status": response.status, "keys": list(result)}, flush=True)
        assert response.ok, "Source runtime prompt request failed"
        assert "SOURCE_RUNTIME_OK" in result.get("reply", ""), "Expected model reply missing"
        page.locator(".turn.text:not(.streaming-turn)").filter(has_text="SOURCE_RUNTIME_OK").first.wait_for()
        page.screenshot(path="/tmp/pih-source-reply.png", full_page=True)
        print("source_prompt_ui PASS", flush=True)
    print("page_errors", errors, flush=True)
    assert not errors, errors
    browser.close()
