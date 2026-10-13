"""channels.report: the ---ATTACH--- card syntax and the card's default title and summary."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from agent_team_backend.channels import redact, report


# --- syntax ---------------------------------------------------------------------------


def test_a_bare_path_is_just_a_path() -> None:
    assert report.parse_attach("/w/a b.pdf") == report.AttachSpec("/w/a b.pdf")


def test_title_and_summary_follow_the_path() -> None:
    spec = report.parse_attach("/w/r.html | title=週報 W41 | summary=三項完成、一項延遲")
    assert spec == report.AttachSpec("/w/r.html", "週報 W41", "三項完成、一項延遲")


def test_unknown_keys_and_odd_spacing_are_tolerated() -> None:
    spec = report.parse_attach("/w/r.html | as=html |  title = T  | nonsense")
    assert spec == report.AttachSpec("/w/r.html", "T", "")


def test_a_value_may_contain_an_equals_sign() -> None:
    assert report.parse_attach("/w/r.html | summary=a=b").summary == "a=b"


@pytest.mark.skipif(sys.platform == "win32", reason="Windows file names cannot contain |")
def test_an_existing_file_whose_name_has_a_bar_is_one_path(tmp_path: Path) -> None:
    f = tmp_path / "a | title=b.txt"
    f.write_text("x")
    assert report.parse_attach(str(f)) == report.AttachSpec(str(f))


# --- cleaning -------------------------------------------------------------------------


def test_values_are_one_line_without_controls_and_capped() -> None:
    assert report.clean("a\n b\x1b\tc", 80) == "a b c"
    assert report.clean("x" * 100, report.TITLE_MAX) == "x" * (report.TITLE_MAX - 1) + "…"
    assert report.clean("   ", 80) == ""


def test_values_are_redacted(monkeypatch) -> None:
    monkeypatch.setattr(redact._filter, "_secrets", {"bot-secret-123456"})
    assert report.clean("token bot-secret-123456", 160) == f"token {redact.REDACTED}"


# --- defaults -------------------------------------------------------------------------


def _plan(name: str = "Channel 溝通能力優化", overview: str = "第一階段", todos=None, stage="in-review") -> str:
    meta = {"schemaVersion": 1, "name": name, "overview": overview, "stage": stage,
            "todos": todos if todos is not None else [{"id": "a", "status": "done"}, {"id": "b", "status": "pending"}]}
    return (f'<!doctype html><html><head><title>Other</title>\n<script type="application/json" id="plan-meta">\n'
            f'{json.dumps(meta, ensure_ascii=False)}\n</script><meta name="description" content="desc"></head>')


def test_a_plan_document_uses_its_name_and_overview() -> None:
    d = report.defaults("x_abc123.html", _plan())
    assert (d.title, d.summary) == ("Channel 溝通能力優化", "第一階段")
    assert (d.stage, d.todos_done, d.todos_total) == ("in-review", 1, 2)


def test_other_html_uses_title_then_description() -> None:
    d = report.defaults("page.html", '<html><head><meta content="一行 &amp; 摘要" name="Description">'
                                     "<title>  報告\n標題 </title></head>")
    assert (d.title, d.summary, d.stage) == ("報告 標題", "一行 & 摘要", "")


def test_without_anything_the_file_name_is_the_title() -> None:
    assert report.defaults("weekly-report.v2.xlsx", "").title == "weekly-report.v2"
    assert report.defaults("page.html", "<p>hi</p>").summary == ""


def test_a_broken_plan_meta_falls_back_to_the_title() -> None:
    head = '<title>T</title><script type="application/json" id="plan-meta">{not json</script>'
    assert report.defaults("p.html", head).title == "T"


def test_the_pane_given_values_win() -> None:
    card = report.card_for(report.AttachSpec("/w/x.html", "Mine", ""), "x.html", _plan())
    assert (card.title, card.summary) == ("Mine", "第一階段")


# --- the card -------------------------------------------------------------------------


def test_the_info_line_of_a_plan_pdf() -> None:
    card = report.card_for(report.AttachSpec("/w/x.html"), "x.html", _plan())
    card = card.sent_as("pdf", size=1258291, pages=12)
    assert report.info_line(card, "zh-TW") == "Plan · in-review · 待辦 1/2 · PDF 12 頁 · 1.2 MB"


def test_the_info_line_of_another_file() -> None:
    card = report.card_for(report.AttachSpec("/w/t.xlsx"), "t.xlsx", "").sent_as("xlsx", size=348160)
    assert report.info_line(card, "zh-TW") == "XLSX · 340 KB"


def test_a_failed_conversion_says_why() -> None:
    card = report.card_for(report.AttachSpec("/w/x.html"), "x.html", _plan()).sent_as(
        "html", size=10, failure="timeout")
    assert report.info_line(card, "zh-TW") == "⚠️ PDF 轉換失敗：逾時，附上原始檔"


def test_plain_card_text_has_title_summary_and_info() -> None:
    card = report.card_for(report.AttachSpec("/w/x.html"), "x.html", _plan()).sent_as("pdf", size=10, pages=1)
    assert report.plain_text(card, "zh-TW").split("\n") == [
        "📄 Channel 溝通能力優化", "第一階段", "Plan · in-review · 待辦 1/2 · PDF 1 頁 · 10 B"]


def test_a_card_without_summary_has_two_lines() -> None:
    card = report.card_for(report.AttachSpec("/w/a.png"), "a.png", "").sent_as("png", size=10)
    assert report.plain_text(card, "zh-TW").split("\n") == ["📄 a", "PNG · 10 B"]


@pytest.mark.parametrize("lang", ["zh-TW", "en-US", "ja-JP"])
def test_every_language_renders_every_failure(lang: str) -> None:
    for reason in report.FAILURES:
        card = report.card_for(report.AttachSpec("/w/x.html"), "x.html", "").sent_as("html", size=1, failure=reason)
        assert report.info_line(card, lang)
