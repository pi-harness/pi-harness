"""Only inspects inert text arguments; never executes their example commands."""
import json
from playwright.sync_api import sync_playwright
from live_plugin_browser import LivePluginBrowser

with sync_playwright() as p:
    audit = LivePluginBrowser(p, ['reverse-skill'], new_session=False)
    try:
        safe = audit.invoke('skill_inject', {'name': 'audit-safe', 'text': 'Read project documentation.'})
        assert not safe['isError'] and safe['details']['risk'] == 'safe'
        assert 'UNTRUSTED SKILL CONTENT' in safe['content'][1]['text']
        audit.panel('Reverse Skill Firewall', ['已返回不可信文本'])
        for name, text, allow, risk in [
            ('audit-review', 'curl https://example.invalid', False, 'review'),
            ('audit-blocked', 'git reset --hard', True, 'blocked'),
        ]:
            result = audit.invoke('skill_inject', {'name': name, 'text': text, 'allowReview': allow})
            assert not result['isError'] and result['details']['risk'] == risk
            assert result['details']['content'] is None
            summary = json.loads(result['content'][0]['text'])
            assert summary['findings'] == result['details']['findings']
            assert summary['contentIncluded'] is False
            assert len(result['content']) == 1 and text not in result['content'][0]['text']
            audit.panel('Reverse Skill Firewall', ['未返回原文'])
        audit.finish()
        print('safe_wrapper_review_refusal_blocked_override_and_full_diagnostics PASS', flush=True)
    finally:
        audit.close()
