"""Settings → Resource limits: reclaim a self-evolution pane its run timed out on.

A run past its time limit is reported as timed out and never killed; until
now its pane also stayed open forever unless the agent eventually reported.
The pane is now reclaimed — turned into a click-to-resume card, never closed —
once a grace period has passed since the timeout. 0 turns it off; a broken
settings read falls back to the default instead of failing the watchdog.
"""

from __future__ import annotations

from typing import Any

from agent_team_backend import resource_limits

from .test_evolve_service import NOW_MS, drain, enable, env, report  # noqa: F401 — fixture

MIN = 60_000


async def _timed_out_run(env, limits: Any = None) -> dict[str, Any]:
    if limits is not None:
        env.service._limits = limits  # noqa: SLF001
    await enable(env, env.a, max_minutes=30)
    await env.service.start_run(env.a, "manual")
    env.clock["now"] = NOW_MS + 31 * MIN
    await env.service.watch_once()
    run = (await env.service.get(env.a))["runs"][0]
    assert run["status"] == "timeout"
    return run


async def test_default_reclaims_after_the_grace_and_only_once(env) -> None:
    await _timed_out_run(env)
    env.clock["now"] += (resource_limits.EVOLVE_RECLAIM_DEFAULT_MINUTES - 1) * MIN
    await env.service.watch_once()
    await drain(env)
    assert env.host.actions == []

    env.clock["now"] += 2 * MIN
    await env.service.watch_once()
    await env.service.watch_once()
    await drain(env)
    assert env.host.actions == [("ui.pane.reclaim", "p-run")]
    assert (await env.service.get(env.a))["runs"][0]["reclaimed"] is True


async def test_zero_turns_it_off(env) -> None:
    await _timed_out_run(env, lambda: {resource_limits.EVOLVE_RECLAIM_KEY: 0})
    env.clock["now"] += 24 * 60 * MIN
    await env.service.watch_once()
    await drain(env)
    assert env.host.actions == []


async def test_a_shorter_grace_takes_effect(env) -> None:
    await _timed_out_run(env, lambda: {resource_limits.EVOLVE_RECLAIM_KEY: 5})
    env.clock["now"] += 6 * MIN
    await env.service.watch_once()
    await drain(env)
    assert env.host.actions == [("ui.pane.reclaim", "p-run")]


async def test_an_unreadable_setting_falls_back_to_the_default(env) -> None:
    def broken() -> dict[str, Any]:
        raise RuntimeError("store unavailable")

    await _timed_out_run(env, broken)
    env.clock["now"] += (resource_limits.EVOLVE_RECLAIM_DEFAULT_MINUTES + 1) * MIN
    await env.service.watch_once()
    await drain(env)
    assert env.host.actions == [("ui.pane.reclaim", "p-run")]


async def test_a_late_report_after_the_reclaim_does_not_reclaim_again(env) -> None:
    run = await _timed_out_run(env, lambda: {resource_limits.EVOLVE_RECLAIM_KEY: 5})
    env.clock["now"] += 6 * MIN
    await env.service.watch_once()
    await drain(env)
    late = await report(env, "p-run", {"run_id": run["id"], "status": "ok", "summary": "late"})
    await drain(env)
    assert late["ok"] is True
    assert env.host.actions == [("ui.pane.reclaim", "p-run")]
    assert (await env.service.get(env.a))["runs"][0]["reclaimed"] is True


async def test_a_report_inside_the_grace_reclaims_the_usual_way(env) -> None:
    run = await _timed_out_run(env)
    await report(env, "p-run", {"run_id": run["id"], "status": "ok", "summary": "late"})
    await drain(env)
    env.clock["now"] += 24 * 60 * MIN
    await env.service.watch_once()
    await drain(env)
    assert env.host.actions == [("ui.pane.reclaim", "p-run")]
