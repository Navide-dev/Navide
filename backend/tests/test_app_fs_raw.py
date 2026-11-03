"""Tests for the GET /fs/raw HTTP endpoint (raw workspace file serving)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agent_team_backend import app as app_module
from agent_team_backend import ws_auth
from agent_team_backend.app import app


@pytest.fixture()
def client() -> TestClient:
    # No context manager: startup events (watchers/MCP) must not run in tests.
    # base_url pinned to loopback: the default "testserver" Host is exactly
    # what reject_foreign_host refuses.
    return TestClient(app, base_url="http://127.0.0.1")


@pytest.fixture()
def workspace(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "video.mp4").write_bytes(bytes(range(256)) * 4)  # 1024 bytes
    (ws / "doc.pdf").write_bytes(b"%PDF-1.4 fake")
    (ws / "blob.zzz").write_bytes(b"\x00\x01\x02unknown")
    (ws / "page.html").write_text("<script>alert(1)</script>")
    (ws / "page.xhtml").write_text("<html xmlns='http://www.w3.org/1999/xhtml'/>")
    (ws / "script.js").write_text("alert(1)")
    (ws / "vector.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")
    (ws / "font.woff2").write_bytes(b"wOF2fake")
    (ws / "sub").mkdir()
    (ws / ".agent-team").mkdir()
    (ws / ".agent-team" / "secret.txt").write_text("internal")
    (tmp_path / "outside.txt").write_text("outside")
    return ws




@pytest.fixture(autouse=True)
def ws_token():
    # The HTTP file routes share the ws token as their credential. Every test
    # here runs with one issued; the refusal tests then drop or corrupt it.
    ws_auth._reset_for_test("test-ws-token")
    yield "test-ws-token"
    ws_auth._reset_for_test("")


def _get(client, ws, rel, **kwargs):
    return client.get("/fs/raw", params={"workspace": str(ws), "rel": rel, "t": "test-ws-token"}, **kwargs)


def test_raw_without_a_token_is_refused(client, workspace):
    # The route used to be reachable by any local account: loopback is not a
    # credential, and workspace=/ made the escape check moot. The token file is
    # 0600 — that permission is the boundary, and this route must sit inside it.
    resp = client.get("/fs/raw", params={"workspace": str(workspace), "rel": "video.mp4"})
    assert resp.status_code == 403


def test_raw_with_a_wrong_token_is_refused(client, workspace):
    resp = client.get("/fs/raw", params={"workspace": str(workspace), "rel": "video.mp4", "t": "nope"})
    assert resp.status_code == 403


def test_raw_refuses_everyone_when_no_token_was_issued(client, workspace):
    # An unissued token must not match an empty query: fail closed.
    ws_auth._reset_for_test("")
    resp = client.get("/fs/raw", params={"workspace": str(workspace), "rel": "video.mp4", "t": ""})
    assert resp.status_code == 403


def test_raw_agent_team_dir_protected_under_any_spelling(client, workspace):
    """On a case-insensitive filesystem `.Agent-Team` opens the same directory
    as `.agent-team`; the guard must ask the filesystem, not compare strings."""
    variant = workspace / ".Agent-Team" / "secret.txt"
    if not variant.exists():
        pytest.skip("filesystem is case-sensitive; the variant is a different path here")
    resp = _get(client, workspace, ".Agent-Team/secret.txt")
    assert resp.status_code == 400
    resp = _get(client, workspace, ".AGENT-TEAM/secret.txt")
    assert resp.status_code == 400


def test_raw_agent_team_dir_protected_through_a_symlink(client, workspace, tmp_path):
    # A link named anything, pointing at the internal dir, is still the
    # internal dir on disk.
    link = workspace / "shortcut"
    link.symlink_to(workspace / ".agent-team")
    resp = _get(client, workspace, "shortcut/secret.txt")
    assert resp.status_code == 400


def test_raw_happy_path_mp4(client, workspace):
    resp = _get(client, workspace, "video.mp4")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "video/mp4"
    assert resp.content == bytes(range(256)) * 4


def test_raw_content_type_pdf(client, workspace):
    resp = _get(client, workspace, "doc.pdf")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/pdf"


def test_raw_unknown_extension_falls_back_to_octet_stream(client, workspace):
    resp = _get(client, workspace, "blob.zzz")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/octet-stream"


def test_raw_html_inline_with_csp_sandbox(client, workspace):
    # HTML is served inline for the sandboxed iframe preview; CSP sandbox
    # keeps it an opaque origin with scripts/forms/plugins blocked.
    resp = _get(client, workspace, "page.html")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    assert "content-disposition" not in resp.headers
    assert resp.headers["content-security-policy"] == "sandbox"
    assert resp.headers["x-content-type-options"] == "nosniff"


def test_raw_xhtml_inline_with_csp_sandbox(client, workspace):
    resp = _get(client, workspace, "page.xhtml")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/xhtml+xml"
    assert "content-disposition" not in resp.headers
    assert resp.headers["content-security-policy"] == "sandbox"


def test_raw_js_downgraded_to_attachment(client, workspace):
    # Non-media, non-HTML types must never render inline on the backend
    # origin (XSS): downgraded to an opaque attachment.
    resp = _get(client, workspace, "script.js")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/octet-stream"
    assert resp.headers["content-disposition"].startswith("attachment")
    assert resp.headers["content-security-policy"] == "sandbox"
    assert resp.headers["x-content-type-options"] == "nosniff"


def test_raw_svg_inline_but_sandboxed(client, workspace):
    # SVG stays viewable in <img> while CSP sandbox blocks direct-nav scripts.
    resp = _get(client, workspace, "vector.svg")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/svg+xml"
    assert resp.headers["content-security-policy"] == "sandbox"


def test_raw_font_inline(client, workspace):
    # Fonts are inline so the specimen preview's @font-face can fetch them.
    resp = _get(client, workspace, "font.woff2")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "font/woff2"
    assert "content-disposition" not in resp.headers
    assert resp.headers["content-security-policy"] == "sandbox"


def test_raw_pdf_has_no_csp_sandbox(client, workspace):
    # CSP sandbox would disable Chromium's embedded PDF viewer.
    resp = _get(client, workspace, "doc.pdf")
    assert "content-security-policy" not in resp.headers
    assert resp.headers["x-content-type-options"] == "nosniff"


def test_raw_range_request_returns_206(client, workspace):
    resp = _get(client, workspace, "video.mp4", headers={"Range": "bytes=0-99"})
    assert resp.status_code == 206
    assert resp.content == (bytes(range(256)) * 4)[:100]
    assert len(resp.content) == 100
    assert resp.headers["content-range"] == "bytes 0-99/1024"


def test_raw_path_escape_rejected(client, workspace):
    resp = _get(client, workspace, "../outside.txt")
    assert resp.status_code == 400


def test_raw_agent_team_dir_protected(client, workspace):
    resp = _get(client, workspace, ".agent-team/secret.txt")
    assert resp.status_code == 400


def test_raw_agent_team_plans_html_served(client, workspace):
    plans = workspace / ".agent-team" / "plans"
    plans.mkdir()
    (plans / "plan.html").write_text("<h1>plan</h1>")
    resp = _get(client, workspace, ".agent-team/plans/plan.html")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    assert resp.headers["content-security-policy"] == "sandbox"


def test_raw_agent_team_plans_traversal_rejected(client, workspace):
    (workspace / ".agent-team" / "plans").mkdir()
    resp = _get(client, workspace, ".agent-team/plans/../secret.txt")
    assert resp.status_code == 400


@pytest.mark.parametrize("root_rel", ["", ".agent-team", ".agent-team/mockups"])
def test_raw_mockup_html_served_under_each_root(client, workspace, root_rel):
    mockups = workspace / ".agent-team" / "mockups"
    mockups.mkdir()
    document = mockups / "preview.html"
    document.write_text("<h1>mockup</h1>")
    root = workspace / root_rel
    response = _get(client, root, str(document.relative_to(root)))
    assert response.status_code == 200
    assert response.text == "<h1>mockup</h1>"
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["content-security-policy"] == "sandbox"


def test_raw_mockup_traversal_still_protected(client, workspace):
    (workspace / ".agent-team" / "mockups").mkdir()
    response = _get(client, workspace, ".agent-team/mockups/../secret.txt")
    assert response.status_code == 400
    assert response.json()["detail"] == "the internal directory is protected"


def test_raw_missing_file_returns_404(client, workspace):
    resp = _get(client, workspace, "nope.bin")
    assert resp.status_code == 404


def test_raw_directory_returns_400(client, workspace):
    resp = _get(client, workspace, "sub")
    assert resp.status_code == 400


def test_raw_nonexistent_workspace_rejected(client, tmp_path):
    # Same trust boundary as ws fs.* handlers: any existing directory is a
    # valid workspace; a non-existent one fails _resolve_safe with 400.
    resp = client.get(
        "/fs/raw",
        params={"workspace": str(tmp_path / "no-such-ws"), "rel": "a.txt", "t": "test-ws-token"},
    )
    assert resp.status_code == 400


def test_raw_offloads_the_blocking_helper(client, workspace, monkeypatch):
    """The route is `async def`, so FastAPI runs it on the event loop itself.
    _resolve_safe/is_dir/is_file are real syscalls that hang for minutes on a
    stalled cloud mount — they belong on a worker thread (issue #24)."""
    threaded_fns: list[Any] = []
    orig_to_thread = asyncio.to_thread

    async def spy(fn: Any, *args: Any, **kwargs: Any) -> Any:
        threaded_fns.append(fn)
        return await orig_to_thread(fn, *args, **kwargs)

    monkeypatch.setattr(asyncio, "to_thread", spy)
    resp = _get(client, workspace, "video.mp4")

    assert resp.status_code == 200
    assert app_module._serve_workspace_file in threaded_fns
