"""The daily Shipped Log digest: the last 24 hours, pushed to the bound chats.

Its clock is a Navide system job in the scheduler (``ship_digest:<project
id>``, action kind ``ship_digest``), the same way a workspace's
self-evolution keeps its clock: only this module writes it, nobody else may
change it, and it is not an agent's job, so no agent limit or expiry applies.
A run wakes no pane and spends no pane's quota. The settings live in the
workspace's own ledger (``ship_settings``).

What leaves for the chat is the chat rendering of the report (sensitive items
and detected commands only counted), masked like ``/shipped``. It goes to
every bound direct chat once, the way Navide's other notices do.
"""

from __future__ import annotations

import asyncio
import os
import re
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from agent_team_backend.plugins.builtin.navide_shipped_log import messages
from agent_team_backend.plugins.builtin.navide_shipped_log import report as ship_report
from agent_team_backend.plugins.builtin.navide_shipped_log.ledger import ShipLogLedger, ledger as _default

PLUGIN_ID = "navide.shipped-log"
FEATURE = "shipped-log"
ACTION_KIND = "ship_digest"
WINDOW = timedelta(hours=24)
TIMEOUT_S = 300
_AT_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


class SettingsInvalid(ValueError):
    pass


def _canonical(workspace: str) -> str:
    return os.path.realpath(os.path.abspath(workspace)) if workspace else ""


def job_id_for(workspace: str) -> str:
    from agent_team_backend.projects import _project_id_for

    return f"{ACTION_KIND}:{_project_id_for(_canonical(workspace))}"


def _book(book: ShipLogLedger | None) -> ShipLogLedger:
    return book or _default


def _local_tz() -> str:
    key = getattr(datetime.now().astimezone().tzinfo, "key", None)
    return str(key) if key else (os.environ.get("TZ") or "UTC")


def validate(updates: Any) -> dict[str, Any]:
    """The accepted subset of a settings update; raises SettingsInvalid."""
    if not isinstance(updates, dict):
        raise SettingsInvalid("settings must be an object")
    out: dict[str, Any] = {}
    for key, value in updates.items():
        if key in ("digest_enabled", "digest_skip_empty"):
            if not isinstance(value, bool):
                raise SettingsInvalid(f"{key} must be true or false")
            out[key] = value
        elif key == "digest_at":
            if not isinstance(value, str) or not _AT_RE.match(value):
                raise SettingsInvalid('digest_at must be "HH:MM"')
            out[key] = value
        elif key == "digest_tz":
            if not isinstance(value, str):
                raise SettingsInvalid("digest_tz must be a time zone name")
            if value:
                try:
                    ZoneInfo(value)
                except (ZoneInfoNotFoundError, ValueError) as err:
                    raise SettingsInvalid(f"unknown time zone: {value!r}") from err
            out[key] = value
        else:
            raise SettingsInvalid(f"unknown setting: {key}")
    return out


def _scheduler() -> Any:
    from agent_team_backend import scheduler

    return scheduler.get_service()


async def _sync_job(workspace: str, settings: dict[str, Any]) -> None:
    from agent_team_backend.scheduler import system_owner

    raw = {
        "name": f"Shipped Log digest · {os.path.basename(workspace) or workspace}",
        "enabled": bool(settings["digest_enabled"]),
        "schedule": {"kind": "daily", "at": settings["digest_at"], "tz": settings["digest_tz"] or _local_tz()},
        "action": {"kind": ACTION_KIND, "workspace": workspace},
        "policy": {"catch_up": "once", "max_runs_per_day": 2, "timeout_s": TIMEOUT_S},
    }
    answer = await _scheduler().system_put(job_id_for(workspace), raw, system_owner(FEATURE, workspace))
    if not answer.get("ok"):
        raise SettingsInvalid(str(answer.get("error") or "could not save the schedule"))


async def get(workspace: str, *, book: ShipLogLedger | None = None) -> dict[str, Any]:
    workspace = _canonical(workspace)
    settings = await asyncio.to_thread(_book(book).settings, workspace)
    job = await _scheduler().store.get_job(job_id_for(workspace))
    state = (job or {}).get("state") or {}
    return {"ok": True, "settings": settings, "job_id": job_id_for(workspace),
            "next_run_at": state.get("next_run_at"), "last_run_at": state.get("last_run_at"),
            "last_status": state.get("last_status"), "last_skip_reason": state.get("last_skip_reason")}


async def set_settings(workspace: str, updates: Any, *, book: ShipLogLedger | None = None) -> dict[str, Any]:
    """Save digest settings and the system job that follows them."""
    workspace = _canonical(workspace)
    if not os.path.isdir(workspace):
        return {"ok": False, "error": "the workspace folder does not exist"}
    try:
        accepted = validate(updates)
        settings = await asyncio.to_thread(_book(book).put_settings, workspace, accepted)
        await _sync_job(workspace, settings)
    except (SettingsInvalid, ValueError) as err:
        return {"ok": False, "error": str(err)}
    return await get(workspace, book=book)


async def run_now(workspace: str, *, book: ShipLogLedger | None = None) -> dict[str, Any]:
    """Push a digest now, through the scheduler so it lands in its history."""
    from agent_team_backend.scheduler import system_owner

    workspace = _canonical(workspace)
    if not os.path.isdir(workspace):
        return {"ok": False, "error": "the workspace folder does not exist"}
    if await _scheduler().store.get_job(job_id_for(workspace)) is None:
        settings = await asyncio.to_thread(_book(book).settings, workspace)
        await _sync_job(workspace, settings)
    answer = await _scheduler().run_now(job_id_for(workspace), system_owner(FEATURE, workspace))
    return {"ok": bool(answer.get("ok")), **({"error": str(answer.get("error"))} if not answer.get("ok") else {})}


def _disabled() -> bool:
    from agent_team_backend import app

    return PLUGIN_ID in app.host_disabled_plugins()


def _language() -> str:
    from agent_team_backend import app, prompt_skills

    try:
        return prompt_skills.language(app.ui_settings_store.get())
    except Exception:  # noqa: BLE001 - the default language still reads
        return prompt_skills.DEFAULT_LANGUAGE


async def compose(workspace: str, lang: str, *, now: datetime | None = None,
                  book: ShipLogLedger | None = None) -> tuple[str, dict[str, Any]]:
    """The masked digest text and the report it was made from."""
    from agent_team_backend.channels import shipped_cmds

    end = (now or datetime.now()).astimezone()
    built = await ship_report.build_report(workspace, end - WINDOW, end, ledger=_book(book))
    head = messages.text(lang, "digest_head", workspace=os.path.basename(workspace) or workspace)
    body = ship_report.render_text(built, lang, for_chat=True, now=end)
    return shipped_cmds.mask(f"{head}\n{body}"), built


async def run(workspace: str, *, manual: bool = False, now: datetime | None = None,
              book: ShipLogLedger | None = None, sender: Any = None) -> dict[str, Any]:
    """One scheduled (or manual) digest; answers a scheduler run outcome."""
    workspace = _canonical(workspace)
    if not os.path.isdir(workspace):
        return {"status": "skipped", "reason": "workspace_gone", "detail": "the workspace folder does not exist"}
    if _disabled():
        return {"status": "skipped", "reason": "plugin_disabled", "detail": f"{PLUGIN_ID} is turned off"}
    settings = await asyncio.to_thread(_book(book).settings, workspace)
    text, built = await compose(workspace, _language(), now=now, book=book)
    if settings["digest_skip_empty"] and not manual and not built["items"]:
        return {"status": "skipped", "reason": "empty", "detail": "nothing shipped in the last 24 hours"}
    if sender is None:
        from agent_team_backend import channels

        manager = channels.get_manager()
        if manager is None:
            return {"status": "skipped", "reason": "no_chat", "detail": "chat channels are not running"}
        sender = manager.notify_shipped_digest
    sent = await sender(text, workspace)
    if not sent:
        return {"status": "skipped", "reason": "no_chat", "detail": "no direct chat is bound"}
    return {"status": "ok", "detail": f"sent to {sent} chat(s), {built['count']} item(s)"}
