"""Tests for the GET /fs/page/{ws_b64}/{rel:path} HTTP endpoint.

Path-addressed variant of /fs/raw so relative subresources resolve; adds
text/css and font mimes to the inline allowlist.
"""

from __future__ import annotations

import asyncio
import base64
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
    (ws / "page.html").write_text('<link rel="stylesheet" href="./sub/style.css">')
    (ws / "page.htm").write_text('<link rel="stylesheet" href="./sub/style.css">')
    (ws / "style.css").write_text("body { margin: 0 }")
    (ws / "font.woff2").write_bytes(b"wOF2fake")
    (ws / "script.js").write_text("alert(1)")
    (ws / "sub").mkdir()
    (ws / "sub" / "style.css").write_text("h1 { color: red }")
    (tmp_path / "outside.txt").write_text("outside")
    return ws


def _ws_b64(ws) -> str:
    # Unpadded, as the frontend sends it; the route must re-pad.
    return base64.urlsafe_b64encode(str(ws).encode()).decode().rstrip("=")




@pytest.fixture(autouse=True)
def ws_token():
    # The HTTP file routes share the ws token as their credential. Every test
    # here runs with one issued; the refusal tests then drop or corrupt it.
    ws_auth._reset_for_test("test-ws-token")
    yield "test-ws-token"
    ws_auth._reset_for_test("")


def _cap(ws) -> str:
    return ws_auth.page_capability(_ws_b64(ws))


def _get(client, ws, rel, **kwargs):
    return client.get(f"/fs/page/{_cap(ws)}/{_ws_b64(ws)}/{rel}", **kwargs)


def test_page_without_a_capability_is_refused(client, workspace):
    # No cap segment at all: the old two-segment shape no longer routes.
    resp = client.get(f"/fs/page/{_ws_b64(workspace)}/page.html")
    assert resp.status_code in (403, 404)
    # A cap segment that is not the capability.
    resp = client.get(f"/fs/page/not-a-cap/{_ws_b64(workspace)}/page.html")
    assert resp.status_code == 403


def test_page_capability_is_scoped_to_its_workspace(client, workspace, tmp_path):
    # The cap for A must not open B: if it leaks out of a previewed page it
    # grants that one workspace, nothing else.
    other = tmp_path / "other"
    other.mkdir()
    (other / "page.html").write_text("<p>b</p>")
    resp = client.get(f"/fs/page/{_cap(workspace)}/{_ws_b64(other)}/page.html")
    assert resp.status_code == 403


def test_page_capability_is_not_the_ws_token(client, workspace):
    # The token itself in the path is exactly what a hostile previewed page
    # could leak through Referer; the route must not accept it as the cap.
    resp = client.get(f"/fs/page/test-ws-token/{_ws_b64(workspace)}/page.html")
    assert resp.status_code == 403


def test_page_relative_subresource_inherits_the_capability(client, workspace):
    # ./sub/style.css from /fs/page/{cap}/{ws}/page.html resolves under the
    # same cap prefix — the reason the route is path-addressed.
    resp = _get(client, workspace, "sub/style.css")
    assert resp.status_code == 200
    assert resp.text == "h1 { color: red }"


@pytest.mark.parametrize("page_name", ["page.html", "page.htm"])
def test_page_html_inline_with_csp_sandbox(client, workspace, page_name):
    resp = _get(client, workspace, page_name)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    assert "content-disposition" not in resp.headers
    assert resp.headers["content-security-policy"] == "sandbox"
    assert resp.headers["x-content-type-options"] == "nosniff"


def test_page_agent_team_plans_html_served(client, workspace):
    # Plan preview: the iframe loads plan HTML from .agent-team/plans via
    # this route; the plans subtree is exempt from the internal-dir guard.
    plans = workspace / ".agent-team" / "plans"
    plans.mkdir(parents=True)
    (plans / "plan.html").write_text("<h1>plan</h1>")
    resp = _get(client, workspace, ".agent-team/plans/plan.html")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    assert resp.headers["content-security-policy"] == "sandbox"


def test_page_agent_team_root_still_protected(client, workspace):
    (workspace / ".agent-team").mkdir(exist_ok=True)
    (workspace / ".agent-team" / "secret.txt").write_text("internal")
    resp = _get(client, workspace, ".agent-team/secret.txt")
    assert resp.status_code == 400


def test_page_mockup_and_relative_assets_served(client, workspace):
    mockups = workspace / ".agent-team" / "mockups"
    assets = mockups / "assets"
    assets.mkdir(parents=True)
    (mockups / "preview.html").write_text(
        '<link rel="stylesheet" href="./assets/style.css"><img src="./assets/image.svg">'
    )
    (assets / "style.css").write_text("body { color: red }")
    (assets / "image.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')

    page = _get(client, workspace, ".agent-team/mockups/preview.html")
    assert page.status_code == 200
    assert page.headers["content-type"].startswith("text/html")
    assert page.headers["content-security-policy"] == "sandbox"
    for name, mime in (("style.css", "text/css"), ("image.svg", "image/svg+xml")):
        asset = client.get(page.url.join(f"./assets/{name}"))
        assert asset.status_code == 200
        assert asset.headers["content-type"].startswith(mime)
        assert asset.headers["content-security-policy"] == "sandbox"
        assert "content-disposition" not in asset.headers


@pytest.mark.parametrize("target", ["internal", "outside"])
def test_page_mockup_symlink_cannot_read_protected_files(client, workspace, target):
    mockups = workspace / ".agent-team" / "mockups"
    mockups.mkdir(parents=True)
    secret = workspace / ".agent-team" / "secret.html" if target == "internal" else workspace.parent / "secret.html"
    secret.write_text("private")
    (mockups / "linked.html").symlink_to(secret)
    response = _get(client, workspace, ".agent-team/mockups/linked.html")
    assert response.status_code == 400
    assert response.json()["detail"] == (
        "the internal directory is protected" if target == "internal" else "path escapes workspace"
    )


def test_page_css_inline(client, workspace):
    # /fs/page difference vs /fs/raw: stylesheets load inline so relative
    # ./style.css subresources work in the sandboxed HTML preview.
    resp = _get(client, workspace, "style.css")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/css")
    assert "content-disposition" not in resp.headers
    assert resp.headers["content-security-policy"] == "sandbox"


def test_page_font_inline(client, workspace):
    resp = _get(client, workspace, "font.woff2")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "font/woff2"
    assert "content-disposition" not in resp.headers
    assert resp.headers["content-security-policy"] == "sandbox"


def test_page_js_downgraded_to_attachment(client, workspace):
    # Scripts stay blocked: same XSS policy as /fs/raw.
    resp = _get(client, workspace, "script.js")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/octet-stream"
    assert resp.headers["content-disposition"].startswith("attachment")
    assert resp.headers["x-content-type-options"] == "nosniff"


def test_page_subdirectory_rel_path(client, workspace):
    resp = _get(client, workspace, "sub/style.css")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/css")
    assert resp.text == "h1 { color: red }"


def test_page_path_escape_rejected(client, workspace):
    # Encoded %2F so the client does not dot-normalize the segment away;
    # starlette decodes it into the rel path param.
    resp = _get(client, workspace, "..%2Foutside.txt")
    assert resp.status_code == 400


def test_page_bad_base64_returns_400(client, workspace):
    bad = "!!!invalid!!!"
    resp = client.get(f"/fs/page/{ws_auth.page_capability(bad)}/{bad}/style.css")
    assert resp.status_code == 400


def test_page_padded_base64_accepted(client, workspace):
    # The cap is computed over the segment exactly as sent, padding included.
    padded = base64.urlsafe_b64encode(str(workspace).encode()).decode()
    resp = client.get(f"/fs/page/{ws_auth.page_capability(padded)}/{padded}/style.css")
    assert resp.status_code == 200


def test_page_missing_file_returns_404(client, workspace):
    resp = _get(client, workspace, "nope.css")
    assert resp.status_code == 404


def test_page_offloads_the_blocking_helper(client, workspace, monkeypatch):
    """Same reason as /fs/raw: the blocking stat work must leave the loop."""
    threaded_fns: list[Any] = []
    orig_to_thread = asyncio.to_thread

    async def spy(fn: Any, *args: Any, **kwargs: Any) -> Any:
        threaded_fns.append(fn)
        return await orig_to_thread(fn, *args, **kwargs)

    monkeypatch.setattr(asyncio, "to_thread", spy)
    resp = _get(client, workspace, "style.css")

    assert resp.status_code == 200
    assert app_module._serve_workspace_file in threaded_fns
