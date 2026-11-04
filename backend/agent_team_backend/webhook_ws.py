"""The window's webhook.* messages, and the listener's lifecycle.

The listener exists only while the global switch is on and at least one trigger
is enabled: `reconcile` is the one place that decides, after every change.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from typing import Any

from . import (
    guard_fail_closed,
    webhook_form,
    webhook_github,
    webhook_keystore,
    webhook_listener,
    webhook_payload,
    webhook_service,
    webhook_triggers,
)
from .ipc import make_error, make_response

log = logging.getLogger(__name__)

_listener: webhook_listener.WebhookListener | None = None
_listener_error = ""

#: Waits before each new try after a failed start. A first launch on a slow
#: machine can miss START_TIMEOUT_S once; a taken port can be freed later.
RETRY_DELAYS_S = (5.0, 15.0, 30.0, 60.0, 120.0)
_retry_task: asyncio.Task[None] | None = None
_failed_starts = 0
_next_retry_at = 0.0
_start_task: asyncio.Task[None] | None = None
_reconcile_lock: tuple[asyncio.AbstractEventLoop, asyncio.Lock] | None = None


def _guard_on() -> bool:
    """Cached, for the listener's thread. Unknown counts as off."""
    from .guard import runtime

    return runtime.enabled_cached() is True


def _service() -> webhook_service.WebhookService:
    service = webhook_service.current()
    if service is None:
        raise RuntimeError("webhooks are not ready")
    return service


async def startup() -> None:
    """Build the service (empty tables on a machine that never used this) and
    bring the listener back if it was on. Reads the Guard switch once, so the
    cached value the listener consults exists."""
    from . import app
    from .guard import runtime

    def build() -> webhook_service.WebhookService:
        runtime.store().enabled()
        return webhook_service.WebhookService(
            store=webhook_triggers.WebhookStore(app.database),
            db=app.database,
            window=webhook_service.LiveWindow(),
            pipeline=_pipeline_record,
            known_program=_known_program,
            project=app.project_store.peek,
        )

    global _start_task
    service = await asyncio.to_thread(build)
    webhook_service.configure(service)
    service.start_watchdog()
    # Not awaited: the backend takes no connection until startup ends, and a
    # listener that is slow to start must not hold all of it up.
    _start_task = asyncio.create_task(_first_reconcile(), name="webhook-listener-start")


async def _first_reconcile() -> None:
    global _start_task
    try:
        await reconcile()
    except Exception as err:  # noqa: BLE001 - as when startup itself failed
        log.warning("webhook startup failed: %s", err)
        webhook_service.mark_unavailable()
    finally:
        _start_task = None


def _pipeline_record(pipeline_id: str) -> dict[str, Any] | None:
    from . import app

    try:
        return app.stages_store.pipeline_record(pipeline_id)
    except KeyError:
        return None


def _known_program(agent_key: str, program: str) -> bool:
    """The vendor's own executable, or the binary the user picked for it. A
    launch command naming anything else is refused."""
    from . import app

    dep = app.onboarding_deps.DEPS_BY_ID.get(agent_key)
    if dep is None:
        return False
    if program and program == app.onboarding_deps.cli_binary_override(agent_key):
        return True
    return app._names_a_known_command(program, (dep.check_cmd[0], *dep.alt_commands))


def _cancel_retry() -> None:
    global _retry_task, _failed_starts
    task, _retry_task = _retry_task, None
    if task is not None and task is not asyncio.current_task():
        task.cancel()
    _failed_starts = 0


async def _retry_later(delay: float) -> None:
    global _retry_task
    await asyncio.sleep(delay)
    # Held while the retry runs, so the status keeps reporting it: cleared in
    # between, a status read during the attempt showed the error with no retry.
    try:
        await reconcile()
    except Exception:  # noqa: BLE001 - a retry must not end as an unretrieved task error
        log.exception("webhook: listener retry failed")
    finally:
        if _retry_task is asyncio.current_task():
            _retry_task = None


def _start_failed(err: webhook_listener.ListenerError) -> None:
    """Record the failure and, below the limit, try again after a wait."""
    global _retry_task, _failed_starts, _listener_error, _next_retry_at
    _failed_starts += 1
    attempts = len(RETRY_DELAYS_S) + 1
    _listener_error = str(err)
    if _failed_starts < attempts:
        delay = RETRY_DELAYS_S[_failed_starts - 1]
        log.warning("webhook: %s (attempt %d of %d, next try in %gs)", err, _failed_starts, attempts, delay)
        _next_retry_at = time.time() + delay
        _retry_task = asyncio.create_task(_retry_later(delay), name="webhook-listener-retry")
    else:
        log.warning("webhook: %s (attempt %d of %d, giving up until webhooks change)", err, _failed_starts, attempts)


async def shutdown() -> None:
    global _listener, _start_task
    task, _start_task = _start_task, None
    retry = _retry_task
    _cancel_retry()
    for pending in (task, retry):
        # Awaited: one cut off mid-start stops the listener it started.
        if pending is not None:
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
    listener, _listener = _listener, None
    if listener is not None:
        await asyncio.to_thread(listener.stop)
    service = webhook_service.current()
    if service is not None:
        await service.stop_watchdog()
    webhook_service.configure(None)


def _lock() -> asyncio.Lock:
    global _reconcile_lock
    loop = asyncio.get_running_loop()
    if _reconcile_lock is None or _reconcile_lock[0] is not loop:
        _reconcile_lock = (loop, asyncio.Lock())
    return _reconcile_lock[1]


async def reconcile() -> None:
    """Start, stop or refresh the listener to match the stored state. A taken
    port is reported, never replaced by another one: the caller's URL names it.
    One at a time: the first one runs beside the window's requests."""
    async with _lock():
        await _reconcile()


async def _reconcile() -> None:
    global _listener, _listener_error, _retry_task
    from . import app

    service = _service()
    settings = await asyncio.to_thread(webhook_triggers.listener_settings, app.database)
    snapshot = await asyncio.to_thread(service.listener_snapshot)
    wanted = settings["enabled"] and bool(snapshot)
    if not wanted:
        _cancel_retry()
        listener, _listener = _listener, None
        if listener is not None:
            await asyncio.to_thread(listener.stop)
        _listener_error = ""
        return
    if _listener is None:
        if _retry_task is not None and _retry_task is not asyncio.current_task():
            # A change while a retry waits tries now; the wait is not stacked.
            _retry_task.cancel()
            _retry_task = None
        listener = webhook_listener.WebhookListener(
            port=settings["port"],
            public_host=settings["public_host"],
            accept=service.accept,
            on_audit=service.audit,
            loop=asyncio.get_running_loop(),
            guard_enabled=_guard_on,
        )
        listener.update(snapshot)
        # The body filter's character class takes 0.3-1 s to build; built in a
        # worker before the port opens, not on the loop by the first request.
        await asyncio.to_thread(webhook_payload._dash_run)
        starting = asyncio.ensure_future(asyncio.to_thread(listener.start))
        try:
            await asyncio.shield(starting)
        except asyncio.CancelledError:
            # The start's thread runs on: a listener it brings up is in no
            # global yet, so nothing else would stop it and it would hold the
            # port until the process ends.
            await asyncio.gather(starting, return_exceptions=True)
            await asyncio.to_thread(listener.stop)
            raise
        except webhook_listener.ListenerError as err:
            _start_failed(err)
            return
        _cancel_retry()
        _listener, _listener_error = listener, ""
        if listener.port != settings["port"]:
            await asyncio.to_thread(
                webhook_triggers.save_listener_settings, app.database, enabled=True, port=listener.port,
                public_host=settings["public_host"], now=int(time.time()),
            )
    else:
        _listener.update(snapshot)


async def _status() -> dict[str, Any]:
    from . import app

    service = _service()
    settings = await asyncio.to_thread(webhook_triggers.listener_settings, app.database)
    return {
        "settings": settings,
        "listening": _listener is not None,
        "port": _listener.port if _listener is not None else 0,
        "error": _listener_error,
        # Not None while a failed start waits for its next try.
        "retry": (
            {"attempt": _failed_starts, "max": len(RETRY_DELAYS_S) + 1, "next_at": int(_next_retry_at)}
            if _retry_task is not None else None
        ),
        "guard_enabled": _guard_on(),
        "key_protection": webhook_keystore.protection(),
        "unattended_supported": guard_fail_closed.unattended_supported(),
        "triggers": await asyncio.to_thread(service.store.list),
        "runs": await asyncio.to_thread(service.open_run_views),
    }


async def webhook_status(session: Any, msg_id: str, msg_type: str, payload: dict) -> None:
    await session.send_json(make_response(msg_id, msg_type, await _status()))


async def webhook_settings_set(session: Any, msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    enabled = payload.get("enabled") is True
    if enabled and not _guard_on():
        await session.send_json(make_error(msg_id, msg_type, "GUARD_OFF", "webhooks need Navide Guard on"))
        return
    stored = await asyncio.to_thread(webhook_triggers.listener_settings, app.database)
    host = str(payload.get("public_host", stored["public_host"]) or "")
    try:
        await asyncio.to_thread(
            webhook_triggers.save_listener_settings, app.database, enabled=enabled, port=stored["port"],
            public_host=host, now=int(time.time()),
        )
    except webhook_triggers.WebhookInvalid as err:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", str(err)))
        return
    if _listener is not None and host != stored["public_host"]:
        await asyncio.to_thread(_stop_for_new_settings)
    await reconcile()
    await session.send_json(make_response(msg_id, msg_type, await _status()))


def _stop_for_new_settings() -> None:
    global _listener
    listener, _listener = _listener, None
    if listener is not None:
        listener.stop()


async def webhook_trigger_create(session: Any, msg_id: str, msg_type: str, payload: dict) -> None:
    """A new, disabled trigger. Its key is in this answer and nowhere else."""
    service = _service()
    try:
        trigger, token = await asyncio.to_thread(
            service.store.create,
            name=str(payload.get("name") or ""),
            workspace=str(payload.get("workspace_path") or ""),
            pipeline_id=str(payload.get("pipeline_id") or ""),
            kind=str(payload.get("kind") or "webhook"),
            per_minute=int(payload.get("per_minute") or webhook_triggers.DEFAULT_PER_MINUTE),
            per_day=int(payload.get("per_day") or webhook_triggers.DEFAULT_PER_DAY),
            no_gate_ack=payload.get("no_gate_ack") is True,
            approval_timeout_min=int(
                payload.get("approval_timeout_min") or webhook_triggers.DEFAULT_APPROVAL_TIMEOUT_MIN
            ),
        )
    except (webhook_triggers.WebhookInvalid, TypeError, ValueError) as err:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", str(err)))
        return
    if trigger["kind"] == "github":
        try:
            token = await asyncio.to_thread(_arm_github, service, trigger, payload.get("events"))
        except webhook_keystore.KeyUnavailable:
            await asyncio.to_thread(service.store.delete, trigger["id"])
            await session.send_json(make_error(msg_id, msg_type, "KEY_UNAVAILABLE", "the key store cannot be reached"))
            return
        except webhook_triggers.WebhookInvalid as err:
            await asyncio.to_thread(service.store.delete, trigger["id"])
            await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", str(err)))
            return
        trigger = next(t for t in await asyncio.to_thread(service.store.list) if t["id"] == trigger["id"])
    if trigger["kind"] == "form":
        try:
            fields = webhook_form.normalize_fields(payload.get("fields"))
        except webhook_form.FormInvalid as err:
            await asyncio.to_thread(service.store.delete, trigger["id"])
            await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", str(err)))
            return
        public = payload.get("form_public") is True
        await asyncio.to_thread(service.store.set_form, trigger["id"], fields, public)
        if public:
            service.audit([{"trigger_id": trigger["id"], "outcome": "form-public", "status": 0}])
        trigger = next(t for t in await asyncio.to_thread(service.store.list) if t["id"] == trigger["id"])
    problem = await asyncio.to_thread(service.binding_problem, trigger)
    if trigger["no_gate_ack"]:
        service.audit([{"trigger_id": trigger["id"], "outcome": "no-gate-acknowledged", "status": 0}])
    await session.send_json(make_response(msg_id, msg_type, {"trigger": trigger, "token": token, "problem": problem}))


def _arm_github(service: webhook_service.WebhookService, trigger: dict[str, Any], events: Any) -> str:
    """Give a new GitHub trigger its secret, made here and shown once."""
    if not isinstance(events, list) or not set(events) <= set(webhook_github.EVENTS):
        raise webhook_triggers.WebhookInvalid("events must come from the supported list")
    secret = secrets.token_hex(32)
    blob = webhook_keystore.encrypt(service.keystore.ensure(), trigger["id"], secret)
    service.store.set_github(trigger["id"], blob, list(events))
    return secret


async def webhook_trigger_enable(session: Any, msg_id: str, msg_type: str, payload: dict) -> None:
    service = _service()
    trigger_id, enabled = str(payload.get("id") or ""), payload.get("enabled") is True
    if enabled:
        if not _guard_on():
            await session.send_json(make_error(msg_id, msg_type, "GUARD_OFF", "webhooks need Navide Guard on"))
            return
        trigger = next((t for t in await asyncio.to_thread(service.store.list) if t["id"] == trigger_id), None)
        if trigger is None:
            await session.send_json(make_error(msg_id, msg_type, "NOT_FOUND", "no such trigger"))
            return
        problem = await asyncio.to_thread(service.binding_problem, trigger)
        if problem:
            await session.send_json(make_error(msg_id, msg_type, "BINDING_REFUSED", problem, {"reason": problem}))
            return
        if (
            trigger["kind"] == "github"
            and webhook_keystore.protection() == "file"
            and payload.get("weak_key_acknowledged") is not True
        ):
            # Said at the moment it matters, not only in the docs.
            await session.send_json(make_error(
                msg_id, msg_type, "WEAK_KEY_ACK_REQUIRED", "on Linux the secret's key is a file only permissions protect",
            ))
            return
    try:
        await asyncio.to_thread(service.store.set_enabled, trigger_id, enabled)
    except webhook_triggers.WebhookNotFound:
        await session.send_json(make_error(msg_id, msg_type, "NOT_FOUND", "no such trigger"))
        return
    await reconcile()
    await session.send_json(make_response(msg_id, msg_type, await _status()))


async def webhook_trigger_set_unattended(session: Any, msg_id: str, msg_type: str, payload: dict) -> None:
    """Per trigger and off by default. Both directions go in the audit trail."""
    service = _service()
    trigger_id, unattended = str(payload.get("id") or ""), payload.get("unattended") is True
    if unattended and not guard_fail_closed.unattended_supported():
        await session.send_json(make_error(msg_id, msg_type, "UNATTENDED_UNSUPPORTED", "not on this platform yet"))
        return
    try:
        await asyncio.to_thread(service.store.set_unattended, trigger_id, unattended)
    except webhook_triggers.WebhookNotFound:
        await session.send_json(make_error(msg_id, msg_type, "NOT_FOUND", "no such trigger"))
        return
    service.audit([{"trigger_id": trigger_id, "outcome": "unattended-on" if unattended else "unattended-off", "status": 0}])
    await reconcile()
    await session.send_json(make_response(msg_id, msg_type, await _status()))


async def webhook_trigger_update(session: Any, msg_id: str, msg_type: str, payload: dict) -> None:
    service = _service()
    try:
        await asyncio.to_thread(
            service.store.set_limits, str(payload.get("id") or ""), int(payload["per_minute"]),
            int(payload["per_day"]), int(payload["approval_timeout_min"]),
        )
    except webhook_triggers.WebhookNotFound:
        await session.send_json(make_error(msg_id, msg_type, "NOT_FOUND", "no such trigger"))
        return
    except (webhook_triggers.WebhookInvalid, KeyError, TypeError, ValueError) as err:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", str(err)))
        return
    await reconcile()
    await session.send_json(make_response(msg_id, msg_type, await _status()))


async def webhook_trigger_rotate(session: Any, msg_id: str, msg_type: str, payload: dict) -> None:
    service = _service()
    trigger_id = str(payload.get("id") or "")
    try:
        trigger = next((t for t in await asyncio.to_thread(service.store.list) if t["id"] == trigger_id), None)
        if trigger is not None and trigger["kind"] == "github":
            token = await asyncio.to_thread(_rotate_github, service, trigger_id)
        else:
            token = await asyncio.to_thread(service.store.rotate, trigger_id)
    except webhook_keystore.KeyUnavailable:
        await session.send_json(make_error(msg_id, msg_type, "KEY_UNAVAILABLE", "the key store cannot be reached"))
        return
    except webhook_triggers.WebhookNotFound:
        await session.send_json(make_error(msg_id, msg_type, "NOT_FOUND", "no such trigger"))
        return
    await reconcile()
    await session.send_json(make_response(msg_id, msg_type, {"token": token}))


def _rotate_github(service: webhook_service.WebhookService, trigger_id: str) -> str:
    """Also how a trigger whose secret was lost is rebuilt, by the user's hand."""
    secret = secrets.token_hex(32)
    service.store.set_github_secret(
        trigger_id, webhook_keystore.encrypt(service.keystore.ensure(), trigger_id, secret),
    )
    return secret


async def webhook_trigger_delete(session: Any, msg_id: str, msg_type: str, payload: dict) -> None:
    service = _service()
    try:
        await asyncio.to_thread(service.store.delete, str(payload.get("id") or ""))
    except webhook_triggers.WebhookNotFound:
        await session.send_json(make_error(msg_id, msg_type, "NOT_FOUND", "no such trigger"))
        return
    await reconcile()
    await session.send_json(make_response(msg_id, msg_type, await _status()))


async def webhook_events(session: Any, msg_id: str, msg_type: str, payload: dict) -> None:
    rows = await asyncio.to_thread(_service().store.events, str(payload.get("id") or ""))
    await session.send_json(make_response(msg_id, msg_type, {"events": rows}))


HANDLERS = {
    "webhook.status": webhook_status,
    "webhook.settings.set": webhook_settings_set,
    "webhook.trigger.create": webhook_trigger_create,
    "webhook.trigger.enable": webhook_trigger_enable,
    "webhook.trigger.set_unattended": webhook_trigger_set_unattended,
    "webhook.trigger.update": webhook_trigger_update,
    "webhook.trigger.rotate": webhook_trigger_rotate,
    "webhook.trigger.delete": webhook_trigger_delete,
    "webhook.events": webhook_events,
}
