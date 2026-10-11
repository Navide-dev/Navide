"""share_scan against the formats and tricks the first review found leaking.

Each case here leaked or was rewritten wrongly by the first version: JSON and
quoted credential values, common provider tokens, a ``data:`` prefix used as a
shield, the Telegram ``/bot`` rule rewriting ordinary paths, and tokens split
by zero-width or full-width characters.
"""

from __future__ import annotations

import pytest

from agent_team_backend import share_scan

R = "Q7wZp3Lk9TfR2mXv8NcB4hJd6YsGe1Ua"  # 32 chars
R36 = R + "AbCd"
PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIE" + R + "\n-----END RSA PRIVATE KEY-----"


def _masked(text: str, kind: str = "plan") -> str:
    return share_scan.scan(text, kind=kind).text


@pytest.mark.parametrize(
    "text",
    [
        "data:text/plain,sk-ant-api03-" + R,
        "data:image/png;base64,iVBORw0KGgo" + "sk-ant-api03-" + R,
        "metadata:sk-ant-api03-" + R + ",x",
        "data:x/y,A" + PEM,
    ],
)
def test_data_uri_does_not_shield_secrets(text: str) -> None:
    out = _masked(text)
    assert R not in out


@pytest.mark.parametrize(
    ("text", "secret"),
    [
        ('{"password": "hunter2-correct-horse"}', "hunter2-correct-horse"),
        ('{"apiKey": "' + R + '"}', R),
        ('{"client_secret": "' + R + '"}', R),
        ('{"token": "' + R + '"}', R),
        ('SECRET="abc def ghi"', "def ghi"),
        ("private_key: '" + R + "'", R),
    ],
)
def test_quoted_credential_values_are_masked_whole(text: str, secret: str) -> None:
    result = share_scan.scan(text, kind="plan")
    assert secret not in result.text
    assert result.findings and result.findings[0].action == share_scan.MASKED


@pytest.mark.parametrize(
    ("text", "category"),
    [
        ("glpat-" + R[:20], "gitlab-token"),
        ("ASIAIOSFODNN7EXAMPLE", "aws-access-key"),
        ("AROAIOSFODNN7EXAMPLE", "aws-access-key"),
        ("sk_live_" + R[:24], "stripe-key"),
        ("rk_test_" + R[:24], "stripe-key"),
        ("npm_" + R36, "npm-token"),
        ("hf_" + "abcdefghijklmnopqrstuvwxyzABCDEFGH", "huggingface-token"),
        ("AIza" + R + "abc", "google-api-key"),
        ("xapp-1-A0123456789-1234567890123-" + R, "slack-app-token"),
        ("SG." + R[:22] + "." + R + R[:11], "sendgrid-key"),
        ("pypi-AgEIcHlwaS5vcmc" + R + R, "pypi-token"),
        ("TELEGRAM 123456789:AAH" + R, "telegram-bot-token"),
        ("MTA" + R[:21] + "." + R[:6] + "." + R[:27], "discord-bot-token"),
    ],
)
def test_common_provider_tokens_are_masked(text: str, category: str) -> None:
    result = share_scan.scan(text, kind="plan")
    assert result.text != text
    assert category in {f.category for f in result.findings}


def test_a_token_glued_to_a_word_character_is_not_matched_mid_word() -> None:
    # "task-management-dashboard" contains "sk-management…"; it is prose, not a key.
    text = "see the task-management-dashboard-overview page"
    assert _masked(text) == text


@pytest.mark.parametrize(
    "text",
    ['<a href="https://shop.test/bottles/list">x</a>', "<td>A/both</td><td>x/y</td>", "/bottom-sheet/"],
)
def test_bot_rule_leaves_ordinary_paths_alone(text: str) -> None:
    assert _masked(text) == text


def test_telegram_bot_url_is_masked() -> None:
    text = "https://api.telegram.org/bot123456789:AAH" + R + "/sendMessage"
    out = _masked(text)
    assert R not in out and out.endswith("/sendMessage")


@pytest.mark.parametrize(
    "text",
    [
        "sk-ant-​api03-" + R,
        "sk​-ant-api03-" + R,
        "ｓｋ-ant-api03-" + R,
        "gh‍p_" + R36,
    ],
)
def test_obfuscated_tokens_are_at_least_warned(text: str) -> None:
    assert share_scan.scan(text, kind="plan").findings


# ---- review round 2 ---------------------------------------------------------------

S = "S3cretValue-9xQ2"


@pytest.mark.parametrize(
    "text",
    [
        '{\\"api_key\\": \\"' + S + '\\"}',  # inside a JSON string (plan-meta)
        "{&quot;api_key&quot;: &quot;" + S + "&quot;}",  # html.escape (visible todo)
        "{&#34;api_key&#34;: &#34;" + S + "&#34;}",
        "{&#x22;api_key&#x22;: &#x22;" + S + "&#x22;}",
        "api_key=&#x27;" + S + "&#x27;",
        "api_key=&apos;" + S + "&apos;",
        "api_key=\\'" + S + "\\'",
    ],
)
def test_escaped_quotes_still_delimit_a_credential(text: str) -> None:
    result = share_scan.scan(text, kind="plan")
    assert S not in result.text
    assert result.findings


def test_masking_keeps_an_escaped_quote_inside_the_value_valid_json() -> None:
    import json

    out = _masked('{"password": "a\\"b-c"}')
    assert json.loads(out) == {"password": "[redacted]"}


def test_a_real_plan_with_a_credential_in_a_todo_stays_a_valid_plan(tmp_path, set_home, monkeypatch) -> None:
    import json
    from html.parser import HTMLParser

    from agent_team_backend.plugins.builtin.navide_plans.plan_meta import parse_plan_meta
    from agent_team_backend.plugins.builtin.navide_plans.plan_tools import _create_plan_sync

    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "data"))
    home = set_home(tmp_path / "home")
    ws = home / "ws"
    ws.mkdir(parents=True)
    created = _create_plan_sync(
        str(ws), "Leak check", "A plan", ['Set config {"api_key": "' + S + '"}', 'Then {"password": "a\\"b"}']
    )
    original = (ws / created["rel_path"]).read_text(encoding="utf-8")
    assert original.count(S) == 2  # once in plan-meta, once in the visible todo

    result = share_scan.scan(original, kind="plan")
    assert S not in result.text and "a\\\\\\\"b" not in result.text
    assert len([f for f in result.findings if f.action == share_scan.MASKED]) >= 2

    meta = parse_plan_meta(result.text)
    assert meta is not None, "plan-meta no longer parses"
    assert "[redacted]" in json.dumps(meta["todos"])

    class Tags(HTMLParser):
        def __init__(self) -> None:
            super().__init__()
            self.seen: list[str] = []

        def handle_starttag(self, tag, attrs):
            self.seen.append(tag)

        def handle_endtag(self, tag):
            self.seen.append("/" + tag)

    def tags(html: str) -> list[str]:
        parser = Tags()
        parser.feed(html)
        return parser.seen

    assert tags(result.text) == tags(original)


@pytest.mark.parametrize(
    "text",
    [
        "SECRET_KEY='" + S + "'",
        "SECRET_KEY_BASE=" + S,
        '{"secretKey": "' + S + '"}',
        "passphrase: " + S,
        'signing_key = "' + S + '"',
        "ENCRYPTION_KEY=" + S,
    ],
)
def test_credential_keys_with_prefixes_and_suffixes(text: str) -> None:
    assert S not in _masked(text)


@pytest.mark.parametrize(
    ("text", "secret", "kept"),
    [
        ("redis://:" + S + "@cache.internal:6379/0", S, "@cache.internal:6379/0"),
        ("https://alice:p/" + S + "@example.com/x", S, "@example.com/x"),
        ("redis://:p@ss" + S + "@host", S, "@host"),
    ],
)
def test_url_credentials(text: str, secret: str, kept: str) -> None:
    out = _masked(text)
    assert secret not in out and "p@ss" not in out
    assert out.endswith(kept)


def test_a_bare_literal_after_a_credential_key_is_a_setting() -> None:
    text = "has_passphrase: false\nrequire_token: true\n"
    assert _masked(text) == text


def test_a_hyphenated_header_key_is_a_credential_key() -> None:
    assert R not in _masked("x-api-key: " + R)
