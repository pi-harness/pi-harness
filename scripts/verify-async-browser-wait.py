"""Real browser regression for awaited false/true results and finite deadlines."""
from playwright.sync_api import sync_playwright, Error
from live_plugin_browser import wait_for_async_condition

with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless=False,
    )
    try:
        page = browser.new_page()
        try:
            wait_for_async_condition(page, 'async () => false', timeout=300)
        except TimeoutError:
            pass
        else:
            raise AssertionError('An async false result must not satisfy the condition')
        page.evaluate('window.conditionChecks = 0')
        observed = wait_for_async_condition(page, '''async expected => {
            await Promise.resolve();
            window.conditionChecks += 1;
            return window.conditionChecks >= expected ? {checks: window.conditionChecks} : false;
        }''', arg=3, timeout=2000)
        assert observed == {'checks': 3}
        try:
            wait_for_async_condition(page, '() => new Promise(() => {})', timeout=300)
        except Error as error:
            assert 'Asynchronous browser condition timed out' in str(error)
        else:
            raise AssertionError('A never-settling predicate must reach its deadline')
        try:
            wait_for_async_condition(page, 'async () => { throw new Error("fixture rejection"); }')
        except Error as error:
            assert 'fixture rejection' in str(error)
        else:
            raise AssertionError('Rejected predicates must not silently pass')
        print('awaited_false_repoll_true_deadline_rejection PASS', flush=True)
    finally:
        browser.close()
