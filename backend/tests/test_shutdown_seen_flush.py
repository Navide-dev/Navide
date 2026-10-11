"""The delivered-message ledger is written at shutdown, whatever else fails,
and after the links that deliver messages have stopped (review R2-1).

The flush sat in the middle of the shutdown handler: any of the dozen awaits
before it raising skipped it, and channels and the server link were still
delivering — and recording keys — after it ran.
"""

from __future__ import annotations

import pytest

from agent_team_backend import app, trust_store


@pytest.fixture
def quiet_shutdown(monkeypatch):
    """Every step of the handler stubbed to a recorder, so running it closes
    nothing the rest of the suite still needs."""
    from agent_team_backend import evolve_service, scheduler, voice_handlers

    steps: list[str] = []

    def sync(name):
        return lambda *_a, **_k: steps.append(name)

    def coro(name):
        async def run(*_a, **_k):
            steps.append(name)
        return run

    monkeypatch.setattr(app.cli_risk_service, "close", coro("cli_risk_service.close"))
    monkeypatch.setattr(scheduler, "shutdown", coro("scheduler.shutdown"))
    monkeypatch.setattr(evolve_service, "shutdown", coro("evolve_service.shutdown"))
    monkeypatch.setattr(voice_handlers, "shutdown", coro("voice_handlers.shutdown"))
    monkeypatch.setattr(app.loop_watchdog, "stop", coro("loop_watchdog.stop"))
    monkeypatch.setattr(app.tokens_store, "flush", sync("tokens_store.flush"))
    monkeypatch.setattr(app.dev_time_store, "shutdown", sync("dev_time_store.shutdown"))
    monkeypatch.setattr(app.channels, "stop", coro("channels.stop"))
    monkeypatch.setattr(app.server_link, "stop", coro("server_link.stop"))
    monkeypatch.setattr(trust_store, "flush_seen_messages", sync("flush_seen_messages"))
    for name in ("_log_watcher", "_git_watcher", "_credential_watcher", "_TERMINALS",
                 "_ownerless_sweeper_task", "_mem_probe_task", "_dev_time_sweeper_task"):
        monkeypatch.setattr(app, name, None)

    class Stop(Exception):
        pass

    # Everything after the links: stop the handler there rather than let it
    # close the databases under the rest of the suite.
    async def mcp_shutdown():
        steps.append("mcp_manager.shutdown")
        raise Stop

    monkeypatch.setattr(app.mcp_manager, "shutdown", mcp_shutdown)
    return steps, Stop


async def test_the_ledger_is_flushed_after_the_links_stop(quiet_shutdown):
    steps, stop = quiet_shutdown
    with pytest.raises(stop):
        await app._stop_log_watcher()
    assert "flush_seen_messages" in steps
    assert steps.index("flush_seen_messages") > steps.index("server_link.stop")
    assert steps.index("flush_seen_messages") > steps.index("channels.stop")


async def test_an_earlier_step_that_raises_does_not_skip_the_flush(quiet_shutdown, monkeypatch):
    steps, _stop = quiet_shutdown

    async def broken():
        raise RuntimeError("cli risk service would not close")

    monkeypatch.setattr(app.cli_risk_service, "close", broken)
    with pytest.raises(RuntimeError):
        await app._stop_log_watcher()
    assert steps.count("flush_seen_messages") == 1
