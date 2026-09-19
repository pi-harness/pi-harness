import re

from playwright.sync_api import expect, sync_playwright


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
    page.goto("http://127.0.0.1:4174/", wait_until="networkidle")

    expect(page).to_have_title(re.compile("Pi Harness"))
    expect(page.get_by_role("heading", name="Run Pi where your work lives.")).to_be_visible()
    console = page.get_by_role("img", name="Pi Harness web console")
    expect(console).to_be_visible()

    console_box = console.bounding_box()
    assert console_box is not None
    assert console_box["width"] > 600, "desktop hero should present the real Console at product scale"
    assert console.evaluate("element => element.naturalWidth") == 1440

    page.get_by_role("tab", name="Plugin").click()
    expect(page.get_by_role("heading", name="Add one deliberate capability.")).to_be_visible()

    page.screenshot(path="/tmp/pi-harness-website.png", full_page=True)

    page.set_viewport_size({"width": 1024, "height": 900})
    page.reload(wait_until="networkidle")
    console_box = console.bounding_box()
    assert console_box is not None and console_box["width"] > 450

    page.set_viewport_size({"width": 390, "height": 844})
    page.get_by_role("button", name="Open navigation").click()
    expect(page.get_by_role("navigation", name="Mobile navigation")).to_be_visible()
    page.get_by_role("navigation", name="Mobile navigation").get_by_role("link", name="Docs", exact=True).click()
    expect(page).to_have_url(re.compile("/docs$"))
    expect(page.get_by_role("heading", name="Understand the runtime before you extend it.")).to_be_visible()

    browser.close()
