"""Report cards and HTML-to-PDF on a pane's reply: what goes to the chat, and what is left."""

from __future__ import annotations

import dataclasses
import json
import time
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend.channels import pdf, report
from agent_team_backend.channels.base import InboundMessage

from .test_manager import _MIDS, Env, _armed, _until, env, fast_timers  # noqa: F401 — fixtures
from .test_media_flow import Media, _msg, media_env, ws  # noqa: F401 — fixtures

PDF = b"%PDF-1.7\n<</Type /Pages>> <</Type /Page>> <</Type /Page>>\n%%EOF"


class Host:
    def __init__(self, answer: dict[str, Any] | None = None, data: bytes = PDF) -> None:
        self.answer = answer or {"ok": True}
        self.data = data
        self.calls: list[Path] = []

    async def __call__(self, html_path: Path, pdf_path: Path, timeout_ms: int) -> dict[str, Any]:
        self.calls.append(html_path)
        if self.answer.get("ok"):
            pdf_path.write_bytes(self.data)
        return self.answer


@pytest.fixture
def pdf_env(media_env: Env, tmp_path: Path) -> Env:
    media_env.host = Host()
    media_env.m._seams = dataclasses.replace(media_env.m._seams, pdf_root=lambda: tmp_path / "channels-pdf",
                                             render_pdf=lambda *a: media_env.host(*a))
    return media_env


def _plan(ws: Path) -> Path:
    meta = {"schemaVersion": 1, "name": "Channel 溝通能力優化", "overview": "第一階段：報告書轉 PDF",
            "stage": "approved", "todos": [{"id": "a", "status": "done"}, {"id": "b", "status": "pending"}]}
    f = ws / ".agent-team" / "plans" / "channel-communication-upgrade_37afb4.html"
    f.parent.mkdir(parents=True)
    f.write_text(f'<!doctype html><html><head><script type="application/json" id="plan-meta">'
                 f'{json.dumps(meta, ensure_ascii=False)}</script></head><body>報告</body></html>', "utf-8")
    return f


async def _reply(env: Env, m: Media, body: str, count: int = 1) -> None:
    await _armed(env)
    env.turn_complete("pane-1", _msg(body))
    await _until(lambda: len(m.files) >= count)
    # The reply's sending runs past wait_idle (inbound jobs only): its last step is
    # remembering the cards, after the PDF folder is gone.
    await _until(lambda: sum(len(t) for t in env.m.mirror.reports._by_chat.values()) >= count)
    await env.m.wait_idle()


async def test_a_plan_document_goes_as_a_pdf_with_its_card(pdf_env: Env, ws: Path, tmp_path: Path) -> None:
    m = Media(pdf_env.tg)
    await _reply(pdf_env, m, f"報告在這\n---ATTACH--- {_plan(ws)}")
    (_loc, data, name), = m.files
    assert (data, name) == (PDF, "channel-communication-upgrade_37afb4.pdf")
    assert m.captions[0] == report.Caption("Channel 溝通能力優化", "第一階段：報告書轉 PDF",
                                           f"Plan · approved · 待辦 1/2 · PDF 2 頁 · {len(PDF)} B")
    assert list((tmp_path / "channels-pdf").iterdir()) == []


async def test_the_pane_names_the_card(pdf_env: Env, ws: Path) -> None:
    m = Media(pdf_env.tg)
    await _reply(pdf_env, m, f"---ATTACH--- {ws}/out/chart.png | title=本週圖表 | summary=營收成長 3%")
    assert m.files[0][2] == "chart.png"
    assert m.captions[0] == report.Caption("本週圖表", "營收成長 3%", "PNG · 5 B")
    assert pdf_env.host.calls == []


@pytest.mark.parametrize("answer, why", [
    ({"ok": False, "error_code": "host_unavailable"}, "App 主視窗未連線"),
    ({"ok": False, "error_code": "timeout"}, "逾時"),
])
async def test_a_failed_conversion_sends_the_original_and_says_why(pdf_env: Env, ws: Path,
                                                                   answer: dict, why: str) -> None:
    pdf_env.host.answer = answer
    m = Media(pdf_env.tg)
    plan = _plan(ws)
    await _reply(pdf_env, m, f"---ATTACH--- {plan}")
    assert m.files[0][1:] == (plan.read_bytes(), plan.name)
    assert m.captions[0].title == "Channel 溝通能力優化"
    assert m.captions[0].info == f"⚠️ PDF 轉換失敗：{why}，附上原始檔"


async def test_a_pdf_over_the_platform_limit_sends_the_original(pdf_env: Env, ws: Path) -> None:
    plan = _plan(ws)
    pdf_env.host.data = PDF + b"x" * 4096
    m = Media(pdf_env.tg, upload_max=len(plan.read_bytes()) + 10)
    await _reply(pdf_env, m, f"---ATTACH--- {plan}")
    assert m.files[0][2] == plan.name
    assert m.captions[0].info.endswith("PDF 超過這個平台的上限，附上原始檔")


async def test_a_reply_that_used_up_its_conversion_time_sends_originals(pdf_env: Env, ws: Path,
                                                                        monkeypatch) -> None:
    monkeypatch.setattr(pdf, "REPLY_BUDGET_S", 0)
    m = Media(pdf_env.tg)
    plan = _plan(ws)
    await _reply(pdf_env, m, f"---ATTACH--- {plan}")
    assert pdf_env.host.calls == [] and m.files[0][2] == plan.name
    assert "轉檔時間已用完" in m.captions[0].info


async def test_an_htm_file_in_the_workspace_is_converted_too(pdf_env: Env, ws: Path) -> None:
    page = ws / "out" / "page.htm"
    page.write_text("<title>頁面</title><p>x</p>", "utf-8")
    m = Media(pdf_env.tg)
    await _reply(pdf_env, m, f"---ATTACH--- {page}")
    assert m.files[0][1:] == (PDF, "page.pdf") and m.captions[0].title == "頁面"


async def test_another_workspaces_plan_goes_too(pdf_env: Env, tmp_path: Path) -> None:
    other = tmp_path / "other"
    plan = _plan(other)
    m = Media(pdf_env.tg)
    await _reply(pdf_env, m, f"---ATTACH--- {plan}")
    assert m.files[0][1:] == (PDF, "channel-communication-upgrade_37afb4.pdf")


async def test_start_clears_what_an_earlier_run_left(pdf_env: Env, tmp_path: Path) -> None:
    left = tmp_path / "channels-pdf" / "0123456789abcdef" / "out.pdf"
    left.parent.mkdir(parents=True)
    left.write_bytes(PDF)
    await pdf_env.m.start()
    assert not (tmp_path / "channels-pdf").exists()


# --- replying to a card ----------------------------------------------------------------


async def _reply_to(env: Env, message_id: str, text: str, quoted: str = "") -> None:
    await env.m.handle_inbound(InboundMessage(
        platform="telegram", account="default", chat_id="-100", thread_id="50", sender_id="7",
        sender_name="alice", text=text, message_id=f"m{next(_MIDS)}", is_direct=False, ts=time.time(),
        reply_to_id=message_id, reply_to_text=quoted, reply_to_sender="navide_bot", reply_to_sender_id="123",
        reply_to_self=True))
    await env.m.wait_idle()


async def test_a_reply_to_a_card_names_the_report(pdf_env: Env, ws: Path) -> None:
    m = Media(pdf_env.tg)
    plan = _plan(ws)
    await _reply(pdf_env, m, f"---ATTACH--- {plan}")
    await _reply_to(pdf_env, "f1", "第二階段先做哪個？", quoted=m.captions[0].plain())
    body = pdf_env.fake.delivered[-1][1]
    assert body.startswith(f'[Replying to report "Channel 溝通能力優化" — {plan}]\n> 📄 Channel 溝通能力優化\n')
    assert body.endswith("\n第二階段先做哪個？")


async def test_a_reply_without_quoted_text_still_names_the_report(pdf_env: Env, ws: Path) -> None:
    """Slack: a thread reply carries no quote."""
    m = Media(pdf_env.tg)
    plan = _plan(ws)
    await _reply(pdf_env, m, f"---ATTACH--- {plan}")
    await _reply_to(pdf_env, "f1", "OK")
    assert pdf_env.fake.delivered[-1][1] == f'[Replying to report "Channel 溝通能力優化" — {plan}]\nOK'


async def test_a_reply_to_another_message_is_quoted_as_before(pdf_env: Env, ws: Path) -> None:
    m = Media(pdf_env.tg)
    await _reply(pdf_env, m, f"---ATTACH--- {ws}/out/chart.png")
    await _reply_to(pdf_env, "unknown", "hm", quoted="hello")
    assert pdf_env.fake.delivered[-1][1] == "[Replying to navide_bot]\n> hello\nhm"
