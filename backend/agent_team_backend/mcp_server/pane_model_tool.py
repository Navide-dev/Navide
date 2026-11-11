"""cli_set_model: switch the model a running CLI pane uses (0.2.40).
Registered on the core server from its own module, after the developer
backend tool, so the tools/list order before it stays unchanged."""

from __future__ import annotations

import time
from typing import Any

from mcp.server.fastmcp import Context

# Through the module, not imported names, so a test's monkeypatch of the
# core helpers reaches this tool too.
from . import server as core


def _refusal(code: str, error: str, **extra: Any) -> dict[str, Any]:
    return {"ok": False, "error": error, "error_code": code, **extra}


def _audit(pane: Any, who: str, model: str, effort: str, method: str) -> None:
    """Record the switch in the pane's Navide Guard audit trail, so a model
    change can be traced to the agent that asked for it."""
    from agent_team_backend.guard import runtime as guard_runtime

    what = f"model={model}" + (f" effort={effort}" if effort else "")
    try:
        guard_runtime.store().audit_add({
            "ts": time.time(), "pane_id": pane.pane_id, "vendor": pane.agent_key or "",
            "source": "agent", "tool": "set_model",
            "excerpt": f"model switched by agent {who} via MCP ({method}): {what}"[:500],
            "level": "normal", "action": "allow", "rule_ids": [], "tainted": False,
        })
    except Exception:  # noqa: BLE001 — the switch itself already happened
        core._log.warning("cli_set_model: audit write failed", exc_info=True)


@core.server.tool()
async def cli_set_model(
    target: str, model: str, ctx: Context, effort: str = "", pane_id: str = "",
) -> dict[str, Any]:
    """Switch the model of a CLI pane that is already running.

    `target` uses the same addressing as cli_send, and `pane_id` names one
    exact pane instead. `model` is the model id, checked the same way
    cli_open_agent checks it: a CLI that cannot be told a model, a malformed
    id, or an effort the CLI does not accept is refused before anything is
    typed. Model ids themselves are not validated — an unknown one is the
    CLI's own error to report, so read cli_read_log after the switch.

    How the switch happens depends on the CLI, and the answer says which in
    `method`:
      - "picker" (claude, with no `effort`): claude's bare `/model` picker
        is opened, the cursor moved to the model's row and `s` ("use this
        session only") pressed. Only this session switches; the default for
        new sessions (settings.json) is left alone. The conversation and
        process stay. Takes an alias (opus, sonnet, haiku, fable) or a full
        id such as claude-sonnet-5-5 that names a row on the picker's list.
      - "slash" (codex, with no `effort`): `/model <model>` is typed into the
        pane bare — no message envelope — and submitted, exactly as if the
        user typed it. With an argument it switches this session only.
      - "restart" (every other CLI that takes `--model`, or any `effort`):
        the pane is rebuilt around a new CLI launched with the new model,
        resuming the same conversation. Its pane id changes; the answer's
        `pane_id` is the new one. A pane with no transcript yet reopens fresh.
        A claude switch also lands here when the picker cannot do it (an id
        with no row on its list, one under "More models", no picker, no `s`
        key, or a screen that changed mid-way); the picker is closed first
        and `fallback` names the reason.

    Only an idle pane is switched: one that is mid-turn, starting, awaiting a
    prompt answer, being typed in, or holding a draft is refused with
    error_code "pane-busy" and `hold` naming why — wait (cli_wait_idle) and
    retry. Your own pane, terminal panes, ACP panes, sign-in panes, restore
    placeholders and panes on another device are refused too.

    Afterwards cli_get_status reports the new model under `ui.model`, and a
    restore relaunches on it. The switch is written to the pane's Guard audit
    trail. Returns {ok, target, pane_id, model, effort?, method, fallback?}
    or {ok: false, error, error_code}.
    """
    from agent_team_backend import app, message_routing

    try:
        caller = core._resolve_caller(ctx)
    except core.CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    model = (model or "").strip()
    effort = (effort or "").strip()
    if not model:
        return _refusal("model-required", "`model` is required: the model id to switch to")
    me = caller.pane_id if caller.kind == "pane" else ""
    result, failure = core._resolve_pane_target(caller, me, target, pane_id)
    if failure is not None:
        if not (pane_id or "").strip() and message_routing.route(me, target).remote is not None:
            return _refusal(
                "set-model-local-only",
                f'cannot switch "{target}": it names a pane on another device, and '
                f"only panes on this machine can be switched from here.",
            )
        return failure
    pane = result.pane
    if caller.kind == "pane" and pane.pane_id == caller.pane_id:
        return _refusal(
            "self-set-model",
            "that is your own pane — it is mid-turn while making this call, so it "
            "can never be idle to switch. Ask the user to run /model, or ask "
            "another pane to switch you after your turn ends.",
            target=pane.qualified_name,
        )
    if pane.agent_key == core._TERMINAL_AGENT:
        return _refusal("not-agent-pane", "a terminal pane is a plain shell — it has no model",
                        target=pane.qualified_name)
    refusal = core._refuse_unsupported_model(pane.agent_key, model, effort)
    if refusal:
        return _refusal("model-unsupported", refusal, target=pane.qualified_name)

    reply = await core._ui_request(
        pane.workspace_path,
        "invoke",
        caller=caller,
        route_pane_id=pane.pane_id,
        action="ui.pane.setModel",
        args={"paneId": pane.pane_id, "model": model, "effort": effort},
    )
    if not reply.get("ok"):
        return _refusal(
            str(reply.get("error_code") or "ui_action_failed"),
            str(reply.get("error") or "the window owning this pane did not answer"),
            target=pane.qualified_name,
        )
    payload = reply.get("result") or {}
    if not payload.get("ok"):
        extra = {"hold": payload["hold"]} if payload.get("hold") else {}
        return _refusal(
            str(payload.get("error_code") or "set-model-failed"),
            str(payload.get("error") or "the switch did not go in"),
            target=pane.qualified_name, **extra,
        )
    new_pane_id = str(payload.get("paneId") or pane.pane_id)
    method = str(payload.get("method") or "")
    await core.run_in_db_thread(
        app.project_store.set_pane_model, pane.workspace_path,
        pane_id=new_pane_id, model=model, effort=effort,
    )
    await core.run_in_db_thread(_audit, pane, core._caller_label(caller), model, effort, method)
    answer: dict[str, Any] = {
        "ok": True,
        "target": pane.qualified_name,
        "pane_id": new_pane_id,
        "model": model,
        "method": method,
    }
    if effort:
        answer["effort"] = effort
    if payload.get("fallback"):
        answer["fallback"] = str(payload["fallback"])
    return answer
