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
