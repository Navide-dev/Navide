"""share_scan: what a share link's content is masked for, warned about, or refused.

A share link is published outside the account, so a high-confidence secret
format is masked before anything is encrypted, a heuristic hit only warns, and
some paths are never shareable at all. Findings name a line and a category,
never the matched value.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend import share_scan

GHP = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
PRIVATE_KEY = (
    "-----BEGIN OPENSSH PRIVATE KEY-----\n"
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n"
    "QyNTUxOQAAACDx2a5zv7k3m9p1q2r3s4t5u6v7w8x9y0z1a2b3c4d5e6f7g8\n"
    "-----END OPENSSH PRIVATE KEY-----"
)
SHA40 = "9395b302c0ffee1234567890abcdef1234567890"
# A data: URI whose base64 is long enough to trip the 40+ base64 heuristic and
# happens to contain an AKIA-shaped run between "/" separators.
DATA_URI = "data:image/png;base64," + "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" * 4 + "/AKIAABCDEFGHIJKLMNOP/" + "Q" * 60


def test_ghp_token_is_masked_and_reported_by_line_not_value() -> None:
    result = share_scan.scan(f"line one\ntoken here {GHP} end\n", kind="plan")
    assert GHP not in result.text
    assert "<redacted>" in result.text
    assert [(f.line, f.category, f.action) for f in result.findings] == [(2, "github-token", "masked")]
    assert GHP not in repr(result.findings)


def test_clean_text_is_untouched() -> None:
    text = "<p>Nothing secret here, just a plan.</p>\n"
    result = share_scan.scan(text, kind="plan")
    assert result.text == text
    assert result.findings == []


def test_private_key_block_is_masked_whole() -> None:
    result = share_scan.scan(f"before\n{PRIVATE_KEY}\nafter\n", kind="plan")
    assert "BEGIN OPENSSH PRIVATE KEY" not in result.text
    assert "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ" not in result.text
    assert result.text.startswith("before\n") and result.text.endswith("\nafter\n")
    assert [(f.line, f.category, f.action) for f in result.findings] == [(2, "private-key", "masked")]


def test_data_uri_is_neither_masked_nor_warned() -> None:
    text = f'<img src="{DATA_URI}">\n'
    result = share_scan.scan(text, kind="plan")
    assert result.text == text
    assert result.findings == []


def test_forty_char_sha_is_not_warned() -> None:
    result = share_scan.scan(f"fixed in {SHA40}\n", kind="plan")
    assert result.findings == []


def test_long_hex_that_is_not_a_sha_still_warns() -> None:
    hex64 = "ab" * 32
    result = share_scan.scan(f"key {hex64}\n", kind="plan")
    assert result.text == f"key {hex64}\n"
    assert [(f.line, f.category, f.action) for f in result.findings] == [(1, "possible-secret", "warned")]


def test_transcript_masks_heuristic_hits_too() -> None:
    hex64 = "cd" * 32
    result = share_scan.scan(f"$ env\nSESSION={hex64}\n", kind="transcript")
    assert hex64 not in result.text
    assert [(f.line, f.action) for f in result.findings] == [(2, "masked")]


def test_every_guard_pattern_has_a_category() -> None:
    from agent_team_backend.guard import engine

    assert len(share_scan.HIGH_CONFIDENCE) == len(engine._SECRET_PATTERNS) + 1  # + private-key block


@pytest.fixture
def home(tmp_path: Path, set_home, monkeypatch: pytest.MonkeyPatch) -> Path:
    # The conftest data dir is tmp_path itself, and Navide's own data is never
    # shared, so home and the data dir have to be siblings.
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "data"))
    return set_home(tmp_path / "home")


@pytest.mark.parametrize(
    ("rel", "code"),
    [
        (".ssh/id_ed25519", "denied_name"),
        (".aws/config", "system"),
        (".claude/CLAUDE.md", "memory"),
        ("project/AGENTS.md", "memory"),
        (".claude/projects/p/memory/notes.md", "memory"),
    ],
)
def test_sensitive_paths_are_refused_with_a_reason(home: Path, rel: str, code: str) -> None:
    target = home / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("x")
    reason = share_scan.refusal(str(target))
    assert reason
    assert reason.code == code
    assert reason.message


def test_ordinary_plan_path_is_not_refused(home: Path) -> None:
    target = home / "work" / ".agent-team" / "plans" / "demo_abc123.html"
    target.parent.mkdir(parents=True)
    target.write_text("<html></html>")
    assert share_scan.refusal(str(target)) is None
