from playwright.sync_api import sync_playwright


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for width, height in [(1440, 1000), (1024, 900), (768, 900), (390, 844)]:
        page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
        page.goto("http://127.0.0.1:4174/", wait_until="networkidle")
        page.wait_for_timeout(250)
        metrics = page.evaluate(
            """() => ({
              viewport: [innerWidth, innerHeight],
              body: [document.body.scrollWidth, document.body.scrollHeight],
              shell: document.querySelector('.shell')?.getBoundingClientRect().toJSON(),
              hero: document.querySelector('h1')?.getBoundingClientRect().toJSON(),
              panel: document.querySelector('.runtime-panel')?.getBoundingClientRect().toJSON(),
              rootFont: getComputedStyle(document.documentElement).fontSize,
              h1Font: getComputedStyle(document.querySelector('h1')).fontSize,
              shellWidth: getComputedStyle(document.querySelector('.shell')).width,
            })"""
        )
        print(metrics)
        page.screenshot(path=f"/tmp/pi-harness-{width}.png", full_page=True)
        page.close()
    browser.close()
