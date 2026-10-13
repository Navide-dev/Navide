"""channels.pdf: the print copy, the Host round trip and what counts as a PDF."""

from __future__ import annotations

import asyncio
import re
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend.channels import pdf

PDF = b"%PDF-1.7\n1 0 obj <</Type /Pages /Count 2>>\n2 0 obj <</Type /Page>>\n3 0 obj <</Type/Page>>\n%%EOF"


# --- the print copy -------------------------------------------------------------------


def test_the_policy_and_print_style_come_first_after_the_doctype() -> None:
    out = pdf.print_copy("<!DOCTYPE html>\n<html><head><title>T</title></head><body>x</body></html>")
    assert out.startswith("<!DOCTYPE html>")
    head = out[len("<!DOCTYPE html>"):out.index("<html")]
    assert "Content-Security-Policy" in head and "default-src 'none'" in head
    assert "size: A4" in head and "print-color-adjust: exact" in head


def test_a_page_without_a_doctype_gets_the_policy_first() -> None:
    assert pdf.print_copy("<p>hi</p>").startswith('<meta charset="utf-8">')


def test_the_document_own_http_equiv_is_disabled() -> None:
    out = pdf.print_copy('<html><head><META HTTP-EQUIV="refresh" content="0;url=file:///etc/passwd">'
                         '<meta http-equiv=Content-Security-Policy content="default-src *"></head></html>')
    assert len(re.findall(r"\shttp-equiv=", out, re.IGNORECASE)) == 1  # only ours
    assert "data-blocked-http-equiv" in out


def test_the_page_is_forced_light_ahead_of_its_own_theme() -> None:
    out = pdf.print_copy('<html lang="zh" data-theme="dark"><header>h</header></html>')
    assert '<html data-theme="light" lang="zh" data-theme="dark">' in out
    assert "<header>" in out  # <header> is not mistaken for <html>


def test_pages_are_counted_without_the_pages_tree() -> None:
    assert pdf.count_pages(PDF) == 2


# --- a conversion ---------------------------------------------------------------------


class FakeHost:
    def __init__(self, answer: dict[str, Any] | None = None, write: bytes | None = PDF, delay: float = 0) -> None:
        self.answer = answer if answer is not None else {"ok": True}
        self.write = write
        self.delay = delay
        self.calls: list[tuple[Path, Path, int]] = []

    async def __call__(self, html_path: Path, pdf_path: Path, timeout_ms: int) -> dict[str, Any]:
        self.calls.append((html_path, pdf_path, timeout_ms))
        assert html_path.read_text(encoding="utf-8").count("Content-Security-Policy") == 1
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.write is not None:
            pdf_path.write_bytes(self.write)
        return self.answer


async def test_a_conversion_hands_back_the_pdf_and_leaves_nothing(tmp_path: Path) -> None:
    host = FakeHost()
    async with pdf.converted(b"<p>hi</p>", tmp_path, host, timeout_s=5) as result:
        assert result.failure == "" and result.pages == 2
        assert result.path is not None and result.path.read_bytes() == PDF
        work = result.path.parent
        assert work.parent == tmp_path and host.calls[0][2] == 5000
    assert not work.exists()
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("host, failure", [
    (FakeHost({"ok": False, "error_code": "host_unavailable"}, write=None), "no_host"),
    (FakeHost({"ok": False, "error_code": "timeout"}, write=None), "timeout"),
    (FakeHost({"ok": False, "error_code": "error", "error": "boom"}, write=None), "error"),
    (FakeHost(write=b"<html>not a pdf</html>"), "not_pdf"),
    (FakeHost(write=None), "not_pdf"),
])
async def test_every_failure_leaves_nothing(tmp_path: Path, host: FakeHost, failure: str) -> None:
    async with pdf.converted(b"<p>hi</p>", tmp_path, host, timeout_s=5) as result:
        assert (result.path, result.failure) == (None, failure)
    assert list(tmp_path.iterdir()) == []


async def test_a_host_that_never_answers_times_out(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(pdf, "_ANSWER_GRACE_S", 0)
    async with pdf.converted(b"<p>hi</p>", tmp_path, FakeHost(delay=5), timeout_s=0.05) as result:
        assert result.failure == "timeout"
    assert list(tmp_path.iterdir()) == []


async def test_a_page_that_is_not_utf8_is_not_converted(tmp_path: Path) -> None:
    host = FakeHost()
    async with pdf.converted("<p>中文</p>".encode("big5"), tmp_path, host, timeout_s=5) as result:
        assert result.failure == "error" and host.calls == []


async def test_a_page_over_the_cap_is_not_converted(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(pdf, "SOURCE_MAX_BYTES", 4)
    async with pdf.converted(b"<p>hi</p>", tmp_path, FakeHost(), timeout_s=5) as result:
        assert result.failure == "source_too_large"


async def test_conversions_run_one_at_a_time(tmp_path: Path) -> None:
    running = {"now": 0, "most": 0}

    async def host(html_path: Path, pdf_path: Path, timeout_ms: int) -> dict[str, Any]:
        running["now"] += 1
        running["most"] = max(running["most"], running["now"])
        await asyncio.sleep(0.01)
        pdf_path.write_bytes(PDF)
        running["now"] -= 1
        return {"ok": True}

    async def one() -> None:
        async with pdf.converted(b"<p>x</p>", tmp_path, host, timeout_s=5):
            pass

    await asyncio.gather(one(), one(), one())
    assert running["most"] == 1


def test_startup_clears_whatever_a_crash_left(tmp_path: Path) -> None:
    root = tmp_path / pdf.PDF_DIRNAME
    (root / "abc").mkdir(parents=True)
    (root / "abc" / "out.pdf").write_bytes(PDF)
    pdf.clear(root)
    assert not root.exists()


# --- the Host round trip --------------------------------------------------------------


async def test_the_request_waits_for_the_matching_result(monkeypatch, tmp_path: Path) -> None:
    sent: list[dict[str, Any]] = []

    async def unicast(event: dict[str, Any]) -> bool:
        sent.append(event)
        asyncio.get_running_loop().call_soon(
            pdf.resolve_result, event["payload"]["request_id"], {"ok": True, "bytes": 10})
        return True

    monkeypatch.setattr(pdf, "_unicast_host", unicast)
    answer = await pdf.request_host(tmp_path / "a" / "print.html", tmp_path / "a" / "out.pdf", 1000)
    assert answer == {"ok": True, "bytes": 10}
    assert sent[0]["type"] == pdf.REQUEST_TYPE
    assert set(sent[0]["payload"]) == {"request_id", "html_path", "pdf_path", "timeout_ms"}


async def test_no_host_is_an_answer_not_a_wait(monkeypatch, tmp_path: Path) -> None:
    async def unicast(event: dict[str, Any]) -> bool:
        return False

    monkeypatch.setattr(pdf, "_unicast_host", unicast)
    answer = await pdf.request_host(tmp_path / "print.html", tmp_path / "out.pdf", 1000)
    assert answer["error_code"] == "host_unavailable"


async def test_only_the_host_session_may_answer() -> None:
    class S:
        host_authenticated = False
        sent: list[dict[str, Any]] = []

        async def send_json(self, data: dict[str, Any]) -> None:
            self.sent.append(data)

    s = S()
    await pdf.handle_result(s, "1", pdf.RESULT_TYPE, {"request_id": "x", "response": {"ok": True}})
    assert s.sent[0]["error"]["code"] == "UNAUTHORIZED"
