from __future__ import annotations

import logging

from agent_team_backend.channels import redact
from agent_team_backend.channels.base import Location
from agent_team_backend.channels.relay import (
    ID_ALPHABET,
    RelayAnswer,
    RelayRequest,
    RelayTable,
    answer_payload,
    is_permanent_allow,
    new_request_id,
    parse_answer,
)


def test_request_ids_are_five_letters_without_l() -> None:
    assert "l" not in ID_ALPHABET
    ids = {new_request_id() for _ in range(300)}
    assert all(len(i) == 5 and set(i) <= set(ID_ALPHABET) for i in ids)


def test_parse_text_and_callback_answers() -> None:
    assert parse_answer("yes abcde", "") == RelayAnswer("abcde", "y")
    assert parse_answer("  N  ABCDE ", "") == RelayAnswer("abcde", "n")
    assert parse_answer("2 abcde", "") == RelayAnswer("abcde", "2")
    assert parse_answer("nv1:abcde:y", "") is None  # callback data only counts as a button
    assert parse_answer("", "nv1:abcde:3") == RelayAnswer("abcde", "3")
    for text in ("yes", "yes abcdl", "yes abcdef", "maybe abcde", "0 abcde", "please yes abcde"):
        assert parse_answer(text, "") is None, text
    assert parse_answer("", "nv2:abcde:y") is None


def test_answer_payload_must_fit_the_request() -> None:
    loc = Location("telegram", "default", "1")
    perm = RelayRequest("abcde", "p", "permission", [], loc)
    question = RelayRequest("abcde", "p", "question", ["a", "b"], loc)
    assert answer_payload(perm, "y") == {"kind": "permission", "choice": "allow"}
    assert answer_payload(perm, "n") == {"kind": "permission", "choice": "deny"}
    assert answer_payload(perm, "1") is None
    assert answer_payload(question, "2") == {"kind": "question", "option": 2}
    assert answer_payload(question, "3") is None and answer_payload(question, "y") is None


def test_permanent_allow_wording() -> None:
    for text in (
        "Yes, and don't ask again this session",
        "Yes, and don't ask again for this command in this session",
        "Yes, allow all edits during this session (shift+tab)",
        "Always allow Bash(rm:*)",
        "Yes, and do not ask again",
        "Auto-accept edits",
        "Yes, and switch to auto mode · auto mode handles these prompts for",
        "是，並且不再詢問",
        "一律允許",
        "自動核准",
        "はい、今後は確認しない",
    ):
        assert is_permanent_allow(text), text
    for text in ("Yes", "Yes, just this once", "No, and tell Claude what to do differently (esc)",
                 "Keep it", "Discard"):
        assert not is_permanent_allow(text), text


def test_table_single_use_and_pane_expiry() -> None:
    table = RelayTable()
    loc = Location("telegram", "default", "1")
    a = table.create("p1", "permission", [], loc)
    b = table.create("p2", "permission", [], loc)
    assert table.take(a.id) is a and table.take(a.id) is None
    table.expire_pane("p2")
    assert table.take(b.id) is None


def test_httpx_filter_redacts_without_changing_level(caplog) -> None:
    logger = logging.getLogger("httpx")
    level_before = logger.level
    redact.install()
    redact.install()  # idempotent
    assert logger.level == level_before
    assert sum(isinstance(f, redact.SecretRedactFilter) for f in logger.filters) == 1
    redact.add_secret("xoxb-slack-secret-value")
    with caplog.at_level(logging.INFO, logger="httpx"):
        logger.info('HTTP Request: %s %s "%s"', "POST",
                    "https://api.telegram.org/bot12345:ABCdef_ghi/getUpdates", "HTTP/1.1 200 OK")
        logger.info("auth header xoxb-slack-secret-value leaked")
    text = caplog.text
    assert "12345:ABCdef_ghi" not in text and "/bot<redacted>/getUpdates" in text
    assert "xoxb-slack-secret-value" not in text and "<redacted>" in text
    assert logger.level == level_before


def test_short_values_are_not_registered_as_secrets() -> None:
    f = redact.SecretRedactFilter()
    f.add_secret("abc")
    assert f.redact("abc def") == "abc def"
