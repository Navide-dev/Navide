"""Issue #490: the /plan-mcp endpoint must not fail every call, with an
unexplained -32603, once something has gone wrong inside the SDK.

The SDK runs every stateless request's server task in one task group that
lives as long as the backend. A task that escapes into that group cancels it;
before the fix the group was entered in the app's lifespan task, whose
cancellation uvicorn swallows, so the endpoint kept accepting requests whose
server task was cancelled before it could read them: every call, for every
pane, answered "-32603 Error handling POST request" until the app restarted,
and nothing reached the backend log.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

import httpx
import pytest

from agent_team_backend.mcp_server import auth as plan_mcp_auth, server as plan_mcp, wiring as plan_mcp_wiring

_HEADERS = {"accept": "application/json, text/event-stream", "content-type": "application/json"}
_TOOLS_LIST = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}


class _Escaped(BaseException):
    """Stands in for whatever escaped the SDK's per-request task in #490: the
    SDK catches Exception around the server run, nothing broader."""


async def _post(query: str, body: dict[str, Any] = _TOOLS_LIST) -> httpx.Response:
    transport = httpx.ASGITransport(app=plan_mcp.asgi_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test", timeout=30) as client:
        return await client.post(f"/?{query}", headers=_HEADERS, json=body)


def _host_query() -> str:
    return f"client=host&t={plan_mcp_auth.internal_token()}"


async def test_an_escape_into_the_session_task_group_does_not_strand_every_later_call(caplog: Any) -> None:
    stop = asyncio.Event()
    started = asyncio.Event()

    async def lifespan() -> None:
        # Where the app runs startup(): uvicorn's lifespan task, which swallows
        # its own cancellation and leaves the server serving.
        await plan_mcp.startup()
        started.set()
        try:
            await stop.wait()
        except asyncio.CancelledError:
            return
        await plan_mcp.shutdown()

    host = asyncio.create_task(lifespan())
    await started.wait()
    try:
        assert (await _post(_host_query())).status_code == 200

        async def escape() -> None:
            raise _Escaped("simulated escape")

        manager = plan_mcp._session_manager  # noqa: SLF001
        assert manager is not None and manager._task_group is not None  # noqa: SLF001
        with caplog.at_level(logging.ERROR, logger="agent_team_backend"):
            manager._task_group.start_soon(escape)  # noqa: SLF001
            await asyncio.sleep(0.05)
            # Bounded: before the fix the first call could also hang.
            responses = [await asyncio.wait_for(_post(_host_query()), 10) for _ in range(3)]
        for response in responses:
            assert response.status_code == 200, response.text[:300]
            assert response.json()["result"]["tools"]
        assert not host.done(), "the escape reached the app's lifespan task"
        logged = [r for r in caplog.records if r.name.startswith("agent_team_backend") and r.levelno >= logging.ERROR]
        assert any("_Escaped" in r.getMessage() or (r.exc_info and "_Escaped" in repr(r.exc_info[1])) for r in logged), (
            [r.getMessage() for r in logged]
        )
    finally:
        stop.set()
        with contextlib.suppress(BaseException):
            await host
        with contextlib.suppress(BaseException):
            await plan_mcp.shutdown()


async def test_an_internal_failure_names_its_cause_to_the_client_and_in_the_log(
    monkeypatch: pytest.MonkeyPatch, caplog: Any,
) -> None:
    from mcp.server import streamable_http

    async def broken(*_args: Any, **_kwargs: Any) -> bool:
        raise RuntimeError("simulated transport fault")

    # Inside the SDK's catch-all around a POST, before the request reaches a tool.
    monkeypatch.setattr(streamable_http.StreamableHTTPServerTransport, "_validate_request_headers", broken)
    await plan_mcp.startup()
    try:
        with caplog.at_level(logging.ERROR, logger="agent_team_backend"):
            response = await _post(_host_query())
    finally:
        await plan_mcp.shutdown()
    assert response.status_code == 500
    message = response.json()["error"]["message"]
    assert "Error handling POST request" in message
    assert "RuntimeError" in message and "simulated transport fault" in message
    assert "tools/list" in message and "host" in message
    assert int(response.headers["content-length"]) == len(response.content)
    logged = [r for r in caplog.records if r.name.startswith("agent_team_backend") and r.levelno >= logging.ERROR]
    assert any("tools/list" in r.getMessage() and r.exc_info for r in logged), [r.getMessage() for r in logged]


async def test_a_refused_pane_credential_is_logged_with_its_reason(
    monkeypatch: pytest.MonkeyPatch, caplog: Any,
) -> None:
    monkeypatch.setattr(plan_mcp_wiring, "_PANE_TOKENS", {})
    monkeypatch.setattr(plan_mcp, "_logged_refusals", set())
    await plan_mcp.startup()
    try:
        with caplog.at_level(logging.WARNING, logger="agent_team_backend"):
            first = await _post("pane=p-490-gone&t=" + "not" + "-a-token")
            again = await _post("pane=p-490-gone&t=" + "not" + "-a-token")
    finally:
        await plan_mcp.shutdown()
    assert first.status_code == again.status_code == 401
    assert "caller token rejected" in first.text
    refused = [r.getMessage() for r in caplog.records if "p-490-gone" in r.getMessage()]
    assert len(refused) == 1, refused  # once per pane and reason, not on every call
    assert "caller token rejected" in refused[0]


def test_the_sdk_errors_behind_a_32603_reach_the_backend_log_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    from logging.handlers import RotatingFileHandler

    from agent_team_backend import applog

    path = tmp_path / "backend.log"
    monkeypatch.setattr(applog, "backend_log_path", lambda: path)
    applog.setup_file_logging("info")
    loggers = [logging.getLogger("agent_team_backend"), logging.getLogger("mcp")]
    try:
        sdk = logging.getLogger("mcp.server.streamable_http")
        sdk.info("Terminating session: None")
        try:
            raise RuntimeError("simulated " + "sdk failure")
        except RuntimeError:
            sdk.exception("Error handling POST request")
        for logger in loggers:
            for handler in logger.handlers:
                handler.flush()
        text = path.read_text(encoding="utf-8")
    finally:
        for logger in loggers:
            for handler in list(logger.handlers):
                if isinstance(handler, RotatingFileHandler) and handler.baseFilename == str(path):
                    logger.removeHandler(handler)
                    handler.close()
    assert "Error handling POST request" in text
    assert "RuntimeError: simulated sdk failure" in text  # the traceback, not just the line
    assert "Terminating session" not in text  # the SDK's per-request info stays out
