"""Scope adapters: how each Settings section presents itself to the sync engine.

An adapter answers two questions and nothing else — "what do you hold right
now" and "write this in" — so the engine stays ignorant of what a prompt or an
MCP server is, and a new section is a new adapter rather than a new branch
inside the engine.

**Sync is opt-in, per scope, per machine.** ``enabled_scopes`` starts empty:
nothing leaves a device until someone turns a section on. That is why the
default here is ``False`` rather than ``True`` — a sync feature that switched
itself on would upload a user's MCP secrets because they installed an update.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from typing import Any, Callable

from . import sync_approvals, sync_engine, sync_keyring

log = logging.getLogger("agent_team_backend.sync_scopes")

#: Which sections this machine syncs, as ``{scope: bool}``.
SCOPES_SETTING = "sync-scopes"

#: The renderer's own keys, mirrored here because the backend now writes them
#: too. Kept as literals on purpose: the renderer is the owner and a shared
#: constant would invert that.
PROMPT_SKILLS_KEY = "prompt-skills"
LOOP_PROMPT_KEY = "loop-prompt-text"


def _settings():
    from . import app

    return app.ui_settings_store


def enabled_scopes() -> dict[str, bool]:
    raw = _settings().get().get(SCOPES_SETTING)
    stored = raw if isinstance(raw, dict) else {}
    # A credentials switch an older build left on reads as off, and is written
    # back as off by the next set_scope_enabled.
    return {
        scope: bool(stored.get(scope, False)) and scope not in sync_engine.LOCAL_ONLY_SCOPES
        for scope in sync_engine.SCOPES
    }


#: Internal scopes and the switch each one rides with.
_RIDES_WITH = {"skill-files": "skills"}
#: Whether file modes carry the executable bit here. Windows has no such bit.
_EXEC_BITS = os.name != "nt"


#: Scopes no sync round ever runs, whatever their stored switch says and on
#: any protocol: memory (retired) and credentials (10-09: credentials never
#: sync). The block is here, in the sync layer; the credential vault is left
#: exactly as it is.
NEVER_SYNCED = frozenset(sync_approvals.RETIRED_SCOPES | {"credentials"})


def scope_enabled(scope: str) -> bool:
    """Whether a sync round runs *scope*. Never for a scope sync no longer
    offers (``sync_approvals.RETIRED_SCOPES``: memory), whatever its stored
    switch says — left on by an older build or written by a window: such a
    round pulls nothing, pushes nothing and deletes nothing, here or on the
    server."""
    base = _RIDES_WITH.get(scope, scope)
    if base in NEVER_SYNCED:
        return False
    return enabled_scopes().get(base, False)


def set_scope_enabled(scope: str, enabled: bool) -> dict[str, bool]:
    if scope not in sync_engine.SCOPES:
        raise sync_engine.SyncError(f"{scope!r} is not a protocol scope")
    if enabled and scope == "credentials":
        blocker = credentials_enable_blocker()
        if blocker:
            raise sync_engine.SyncError(blocker)
    if enabled and scope in NEVER_SYNCED:
        # Switching it off stays possible, to clear a switch an older build left on.
        raise sync_engine.SyncError(f"{scope} is not synced any more; it can only be switched off")
    current = enabled_scopes()
    current[scope] = bool(enabled)
    _settings().set({SCOPES_SETTING: current})
    return current


def credentials_enable_blocker() -> str:
    """Why the credentials section may not be switched on right now, or "".

    Credentials are the one scope where the account key's provenance is the
    whole security argument: the key is handed to a new device sealed to an
    X25519 public key, and a device paired before that key was pinned in the
    trust store took it on the server's word. Such a *legacy* pin has to be
    re-paired before a credential goes up — otherwise a compromised server
    could have named itself as that device. A trust store that cannot be
    read is refused too: not knowing is not the same as knowing it is fine.
    """
    from . import trust_store

    legacy = getattr(trust_store, "legacy_pinned_devices", None)
    if legacy is None:
        return ""
    try:
        devices = [str(d) for d in legacy() if d]
    except Exception as err:  # noqa: BLE001 - fail closed, see docstring
        return f"the trust store could not be read: {err}"
    if not devices:
        return ""
    return (
        "these paired devices predate encryption-key pinning and must be unpaired "
        "and paired again before credentials can sync: " + ", ".join(sorted(devices))
    )


#: Items whose delete arrived from another device while this one kept its
#: copy, as ``{scope: {item_id: digest of the kept copy}}``.
DETACHED_KEY = "sync-detached"


def _detached(scope: str) -> dict[str, str]:
    raw = _settings().get().get(DETACHED_KEY)
    entries = raw.get(scope) if isinstance(raw, dict) else None
    return {str(k): str(v) for k, v in entries.items()} if isinstance(entries, dict) else {}


def _set_detached(scope: str, entries: dict[str, str]) -> None:
    # sync-core's engine says whether this round was begun for the account
    # signed in now; a build without it has no such rounds to worry about.
    is_current = getattr(sync_engine, "round_is_current", None)
    if is_current is not None and not is_current():
        return  # a round begun for the previous account must not write its marks into the next one
    raw = _settings().get().get(DETACHED_KEY)
    doc = dict(raw) if isinstance(raw, dict) else {}
    if entries:
        doc[scope] = entries
    else:
        doc.pop(scope, None)
    _settings().set({DETACHED_KEY: doc})


def detach(scope: str, item_id: str, kept: Any | None) -> None:
    """A delete arrived for an item this machine keeps a copy of.

    The rule memory and skills share: a delete made on another device never
    removes the user's file here — it is theirs, not ours — and the copy kept
    here is not pushed back up either, which would undo the delete on the
    device that made it. The item leaves the snapshot until the user changes
    the kept copy, which is a new decision and goes up as one.
    """
    entries = _detached(scope)
    if kept is None:
        entries.pop(item_id, None)
    else:
        entries[item_id] = sync_engine.digest(kept)
    _set_detached(scope, entries)


def attach(scope: str, item_id: str) -> None:
    """A live record arrived for an item: it is in sync again."""
    entries = _detached(scope)
    if entries.pop(item_id, None) is not None:
        _set_detached(scope, entries)


def without_detached(scope: str, snapshot: dict[str, Any]) -> dict[str, Any]:
    """*snapshot* minus the detached items still exactly as they were kept.

    A marker whose copy has since changed or gone is dropped: the change is
    the user's, and from then on the item syncs like any other.
    """
    entries = _detached(scope)
    if not entries:
        return snapshot
    out = dict(snapshot)
    stale = []
    for item_id, kept in entries.items():
        if item_id in out and sync_engine.digest(out[item_id]) == kept:
            del out[item_id]
        else:
            stale.append(item_id)
    if stale:
        for item_id in stale:
            entries.pop(item_id, None)
        _set_detached(scope, entries)
    return out


def _call_on_loop(loop: asyncio.AbstractEventLoop | None, fn: Callable[..., Any], *args: Any) -> None:
    """Run *fn* on *loop*, from whichever thread this is.

    The engine applies a pull page in a worker thread, and what an adapter
    tells the rest of the app (a broadcast, a reload) schedules tasks, which
    only the loop can do. Without a loop (no round has run, or a caller that
    is not the engine) *fn* runs here.
    """
    if loop is None or loop.is_closed():
        fn(*args)
        return
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is loop:
        fn(*args)
    else:
        loop.call_soon_threadsafe(fn, *args)


class PromptsScope:
    """Prompt skills — the Settings → Prompts list.

    The list lives in one settings value, so the adapter explodes it into one
    item per skill id and puts it back together on the way in. Syncing the
    whole array as a single item would make any two devices that both touched
    prompts collide on everything at once.
    """

    scope = "prompts"

    def __init__(self, broadcast: Callable[[dict[str, Any]], None] | None = None, *, gate: bool = True) -> None:
        #: Called with the settings delta after a write, so other windows
        #: converge instead of waiting for a reload.
        self._broadcast = broadcast
        self._loop: asyncio.AbstractEventLoop | None = None
        #: False for a caller that already showed the user this very record
        #: (a settings-bundle import): nothing is held for approval then.
        self._gate = gate

    async def prepare(self, _request: Any, _kick: Callable[[], None]) -> bool:
        """Called by the engine at the start of each round, on the loop."""
        self._loop = asyncio.get_running_loop()
        return True

    # ── reading ─────────────────────────────────────────────────────────
    def _list(self) -> list[dict[str, Any]]:
        raw = _settings().get().get(PROMPT_SKILLS_KEY)
        if not isinstance(raw, list):
            return []
        return [s for s in raw if isinstance(s, dict) and isinstance(s.get("id"), str) and s["id"]]

    def snapshot(self) -> dict[str, Any]:
        # A record waiting for approval stands in for the local one, so the
        # engine pushes nothing over it (sync_approvals).
        return sync_approvals.overlay(self.scope, self.local_snapshot())

    def local_snapshot(self) -> dict[str, Any]:
        """The prompts this machine actually has, approvals aside."""
        return {str(skill["id"]): skill for skill in self._list()}

    # ── writing ─────────────────────────────────────────────────────────
    def apply(self, item_id: str, payload: Any | None) -> bool:
        """Take one record in. A prompt new here, or one that differs from
        this machine's in any field — its text, its switch, being the default
        and so the loop prompt — waits for the user's approval
        (``sync_approvals``, decision S2): a prompt is what a looping pane
        types on the user's behalf. A delete of a prompt that is not the
        default applies as before. A delete of the default is held too: it
        makes another prompt this machine has the loop prompt, and the card
        names which (computed when shown; approval is refused if that prompt
        changed since)."""
        skills = self._list()
        index = next((i for i, s in enumerate(skills) if s.get("id") == item_id), -1)
        if payload == sync_approvals.DELETE_PAYLOAD:
            payload = None  # an approved held delete, landing
            approved_delete = sync_approvals.is_approved(self.scope, item_id, sync_approvals.DELETE_PAYLOAD)
        else:
            approved_delete = False
        if payload is None:
            if index < 0:
                sync_approvals.drop(self.scope, item_id)
                return True
            if self._gate and not approved_delete and _single_default(skills)[index].get("isDefault"):
                # Deleting the default re-casts the loop prompt as another one
                # this machine has: what a looping pane types changes, so it
                # is asked too. Other deletes apply as before.
                if sync_approvals.is_rejected(self.scope, item_id, sync_approvals.DELETE_PAYLOAD):
                    return True
                return sync_approvals.hold(
                    self.scope, item_id, sync_approvals.DELETE_PAYLOAD, local=skills[index],
                    kind=sync_approvals.KIND_DELETE,
                    summary={
                        "id": item_id,
                        "name": str(skills[index].get("name") or item_id),
                        "deletes": True,
                        **_successor_fields(skills, item_id),
                    },
                )
            if approved_delete:
                shown = (sync_approvals.held_summary(self.scope, item_id) or {}).get("newLoopPromptId")
                if _successor_fields(skills, item_id)["newLoopPromptId"] != shown:
                    raise sync_engine.SyncError(
                        f"the prompt that would become the loop prompt changed since {item_id} was shown; "
                        "review it again"
                    )
            sync_approvals.drop(self.scope, item_id)
            skills.pop(index)
        else:
            if not isinstance(payload, dict):
                log.warning("prompt %s arrived as %s, not an object", item_id, type(payload).__name__)
                return False
            incoming = dict(payload)
            incoming["id"] = item_id
            # A bundle strips the flag; a synced record always carries it.
            incoming["isDefault"] = incoming.get("isDefault") is True
            local = skills[index] if index >= 0 else None
            if self._gate and (local is None or sync_engine.digest(local) != sync_engine.digest(incoming)) \
                    and not sync_approvals.is_approved(self.scope, item_id, payload):
                if sync_approvals.is_rejected(self.scope, item_id, payload):
                    return True
                return sync_approvals.hold(
                    self.scope, item_id, payload, local=local,
                    kind=sync_approvals.KIND_NEW if local is None else sync_approvals.KIND_CHANGED,
                    summary={"id": item_id, "name": str(incoming.get("name") or item_id)},
                )
            if index < 0:
                skills.append(incoming)
            else:
                skills[index] = incoming
            if incoming.get("isDefault"):
                # A promotion elsewhere: the incoming default wins. The others
                # are not re-cast record by record — the record demoting the
                # old default can arrive before the one promoting the new one,
                # and picking a stand-in in between is what reverted it.
                skills = [{**s, "isDefault": s.get("id") == item_id} for s in skills]
        self._write(skills)
        return True

    def _write(self, skills: list[dict[str, Any]]) -> None:
        updates: dict[str, Any] = {PROMPT_SKILLS_KEY: skills}
        # The list may hold no flag for a moment (a default deleted elsewhere,
        # a demotion ahead of its promotion); the renderer settles that on read
        # by the same rule ``_single_default`` states.
        default = next((s for s in _single_default(skills) if s.get("isDefault")), None)
        if default is not None and isinstance(default.get("prompt"), str):
            # The renderer mirrors this on every save; a write that skipped it
            # would leave the loop running yesterday's prompt.
            updates[LOOP_PROMPT_KEY] = default["prompt"]
        delta = _settings().set(updates)
        if delta and self._broadcast is not None:
            _call_on_loop(self._loop, self._broadcast, delta)


def _single_default(skills: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Exactly one skill carries ``isDefault`` — the renderer's invariant.

    Sync can break it in both directions: two devices each promoting a
    different skill produces two, and deleting the default produces none. The
    renderer would then cast an arbitrary one, so it is settled here instead,
    where the rule can be stated once.
    """
    if not skills:
        return skills
    # normalizePromptSkills (promptSkills.ts): the first skill flagged and
    # enabled, else the first enabled one — a disabled default casts nothing.
    enabled = [i for i, s in enumerate(skills) if s.get("enabled") is not False]
    claimed = [i for i in enabled if skills[i].get("isDefault")]
    winner = claimed[0] if claimed else (enabled[0] if enabled else 0)
    return [{**s, "isDefault": i == winner} for i, s in enumerate(skills)]


class McpScope:
    """Navide's own MCP server records.

    The native reflection — what each CLI keeps in its own config file — is
    deliberately absent. Those are the user's files in the user's directories,
    and syncing them would mean this feature rewriting ``~/.codex`` and
    ``~/.cursor`` on a machine nobody was looking at.

    Sync is install-only (0.2.32): what travels is the server's definition —
    transport, command, args, url, cwd, enabled and the *names* of its env
    entries and headers. Their values never leave this machine: every copy
    goes up with them empty (``_install_only``), and a record that arrives
    keeps the values this machine already has (``_with_local_values``). A
    name new here lands empty, which the MCP page shows as a field to fill
    in. Records an older build pushed with values in them still open; the
    values in them are read as empty, so the two forms compare as one.

    Install-only records travel under their own item ids, ``i:<name>``
    (``INSTALL_PREFIX``), and the rows older builds keep under ``<name>``
    are never written or deleted from here (``pushes``): an older build
    applies a record as it comes, so a definition without values would empty
    its own. A ``<name>`` row is read as a definition until this machine has
    seen the server's ``i:`` row (``superseded_by``). Older builds cannot use
    an ``i:`` row: no server name may hold ":" (``mcp_settings._NAME_RE``),
    and on legacy item ids the row is sealed apart (``seal_scope``) so the
    builds before 0.2.18, which record a refused row as held and later push
    a delete for it, cannot open it at all.
    """

    scope = "mcp"

    def __init__(
        self,
        on_change: Callable[[], Any] | None = None,
        *,
        gate: bool = True,
        keep_local_values: bool = True,
    ) -> None:
        #: False for a caller that already asked the user about this very
        #: record (a settings-bundle import the user picked items from):
        #: then nothing is held for approval.
        self._gate = gate
        #: False for a caller that filled the env and header values itself
        #: by its own rules (a settings-bundle import: ``restore_secrets``):
        #: then the values it hands ``apply`` are written as they are.
        self._keep_local_values = keep_local_values
        #: Coroutine function run on the loop after a synced write, so the
        #: running servers and the open windows follow it the way they follow
        #: a save in Settings. One run covers every write before it starts.
        self._on_change = on_change
        self._loop: asyncio.AbstractEventLoop | None = None
        self._change_pending = False
        self._change_tasks: set[asyncio.Task[Any]] = set()

    async def prepare(self, _request: Any, _kick: Callable[[], None]) -> bool:
        """Called by the engine at the start of each round, on the loop."""
        self._loop = asyncio.get_running_loop()
        return True

    def _store(self):
        from . import app

        return app.mcp_settings_store

    def _changed(self) -> None:
        if self._on_change is None or self._change_pending or self._loop is None:
            return
        self._change_pending = True
        _call_on_loop(self._loop, self._run_change)

    def _run_change(self) -> None:
        async def run() -> None:
            self._change_pending = False
            try:
                await self._on_change()
            except Exception as err:  # noqa: BLE001 - the write itself stands
                log.warning("the MCP servers could not be reloaded after a sync: %s", err)

        task = asyncio.get_running_loop().create_task(run())
        self._change_tasks.add(task)
        task.add_done_callback(self._change_tasks.discard)

    def snapshot(self) -> dict[str, Any]:
        # A record waiting for approval stands in for the local one, so the
        # engine pushes nothing over it (see ``sync_approvals``).
        # Each server is listed under both its ids: ``<name>`` only so an
        # older build's row of it compares with something (``pushes``).
        local = self.local_snapshot()
        by_id = {INSTALL_PREFIX + name: server for name, server in local.items()}
        by_id.update(local)
        return {item_id: _install_only(server) for item_id, server in sync_approvals.overlay(self.scope, by_id).items()}

    def inbound(self, payload: Any) -> Any:
        """A record from elsewhere as this machine compares it: its env and
        header values dropped, as the ones it sends are."""
        return _install_only(payload)

    def pushes(self, item_id: str) -> bool:
        """Whether the engine may write or delete this item: only ``i:`` rows.
        A ``<name>`` row is an older build's, values and all, and stays as it
        is, so older builds keep syncing it among themselves."""
        return item_id.startswith(INSTALL_PREFIX)

    def superseded_by(self, item_id: str) -> str:
        """The ``i:`` id that replaces a ``<name>`` row, or "" for an ``i:``
        row. Once this machine has seen it, the older row is not read."""
        return "" if item_id.startswith(INSTALL_PREFIX) else INSTALL_PREFIX + item_id

    def seal_scope(self, wire_id: str) -> str:
        """The scope an item is sealed under. An ``i:`` row on legacy item ids
        is sealed apart, so a build before 0.2.32 cannot open it (see the
        class docstring); a hashed id names no prefix and keeps ``mcp``."""
        return INSTALL_SEAL_SCOPE if wire_id.startswith(INSTALL_PREFIX) else self.scope

    def approval_local(self, item_id: str) -> Any:
        """The local server a hold under *item_id* was filed against."""
        return self.local_snapshot().get(_server_name(item_id))

    def withheld(self) -> list[str]:
        """Rejected records whose held copy no longer opens: nothing goes up
        for them (``sync_approvals.withheld``)."""
        return sync_approvals.withheld(self.scope)

    def local_snapshot(self) -> dict[str, Any]:
        """The servers this machine actually has, approvals aside."""
        servers = self._store().list_servers()
        return {str(s["name"]): s for s in servers if isinstance(s.get("name"), str) and s["name"]}

    def apply(self, item_id: str, payload: Any | None) -> bool:
        """Write one record in. False means the store refused it (malformed,
        over the document's limits) and this machine does not hold it.

        A server new here, or one whose command, arguments, url or env names
        changed, is held for the user's approval instead (``sync_approvals``):
        it would run here otherwise. A record held that way counts as taken."""
        store = self._store()
        servers = [s for s in store.list_servers() if isinstance(s, dict)]
        name = _server_name(item_id)
        if name != item_id:
            # The server's install-only row answers for it now: a change held
            # from its older row is not asked about as well.
            sync_approvals.drop(self.scope, name)
        index = next((i for i, s in enumerate(servers) if s.get("name") == name), -1)
        if payload is None:
            sync_approvals.drop(self.scope, item_id)
            if index < 0:
                return True
            servers.pop(index)
        else:
            if not isinstance(payload, dict):
                log.warning("MCP record %s arrived as %s", item_id, type(payload).__name__)
                return False
            local = servers[index] if index >= 0 else None
            if self._keep_local_values:
                payload = _with_local_values(payload, local)
            if self._gate and _mcp_needs_approval(local, {**payload, "name": name}) \
                    and not sync_approvals.is_approved(self.scope, item_id, payload):
                if not _mcp_valid(servers, index, {**payload, "name": name}):
                    # The store would refuse it on approval anyway; holding it
                    # would only let one device fill this machine's disk.
                    log.warning("MCP record %s is not a valid server here; refused", item_id)
                    return False
                if sync_approvals.is_rejected(self.scope, item_id, payload):
                    return True
                return sync_approvals.hold(
                    self.scope, item_id, payload, local=local,
                    kind=sync_approvals.KIND_NEW if local is None else sync_approvals.KIND_CHANGED,
                    summary=_mcp_summary(name, payload),
                )
            if self._gate and _mcp_hides(payload):
                # Checked again when an approved record lands.
                raise sync_engine.SyncError(f"MCP record {item_id} hides characters in what it runs; refused")
            incoming = dict(payload)
            incoming["name"] = name
            if index < 0:
                servers.append(incoming)
            else:
                servers[index] = incoming
        try:
            store.replace_servers(servers)
        except Exception as err:  # noqa: BLE001 - a rejected document is not fatal
            log.warning("the synced MCP document was refused: %s", err)
            return False
        self._changed()
        return True


#: Env names whose value decides what a process loads or runs, whatever
#: else the name says. Matched as whole ``_``-separated parts anywhere in a
#: name, so NODE_OPTIONS_TOKEN counts as NODE_OPTIONS.
_EXEC_ENV_NAMES = frozenset({
    "PATH", "NODE_OPTIONS", "NODE_PATH", "RUBYOPT", "PERL5OPT", "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS", "CLASSPATH", "SHELL", "HOME",
})
_EXEC_ENV_PREFIXES = ("PYTHON", "DYLD_", "LD_", "NPM_CONFIG_", "UV_", "BUN_", "DENO_", "GIT_")
_EXEC_ENV_SUFFIXES = ("_OPTIONS", "_OPTS", "_PATH", "_HOME")
#: Name endings that mark a value as a secret: masked in an approval, and
#: the only names whose value may rotate without one (``_env_rotates``).
_SECRET_ENV_SUFFIXES = ("_TOKEN", "_API_KEY", "_SECRET", "_PASSWORD")
#: Characters a rotated token never holds: a value with any of them names a
#: place (a URL, a path, a file) or carries options, and changing it is a
#: change of behaviour, not of a credential.
_NOT_OPAQUE = re.compile(r"://|[/\\\s=]|\.json", re.IGNORECASE)
#: How many env entries and headers a synced MCP record may carry, and how
#: long a name may be: what an approval can show whole.
MAX_SYNCED_ENV = 64
MAX_SYNCED_NAME = 128


def _env_runs(name: str) -> bool:
    upper = name.upper()
    if upper.startswith(_EXEC_ENV_PREFIXES) or upper.endswith(_EXEC_ENV_SUFFIXES):
        return True
    padded = f"_{upper}_"
    return any(f"_{exec_name.strip('_')}_" in padded for exec_name in _EXEC_ENV_NAMES)


def _env_secret(name: str) -> bool:
    """Whether a name marks its value as a secret: exact endings only."""
    return name.upper().endswith(_SECRET_ENV_SUFFIXES)


def _opaque(value: Any) -> bool:
    return isinstance(value, str) and not _NOT_OPAQUE.search(value)


def _env_rotates(name: str, old: Any, new: Any) -> bool:
    """Whether changing this env value from *old* to *new* is a secret
    rotation, which needs no approval: a secret name that cannot change what
    runs, with an opaque token on both sides."""
    return _env_secret(name) and not _env_runs(name) and _opaque(old) and _opaque(new)


def _mcp_runs(server: Any) -> Any:
    """What of an MCP record decides what runs, apart from env values (see
    ``_mcp_needs_approval``): everything but the on/off switch, with env and
    header *names* (a header value change is a token rotation; a new header
    is a new request to some server)."""
    if not isinstance(server, dict):
        return None
    out = {k: v for k, v in server.items() if k not in ("enabled", "env", "headers")}
    env = server.get("env")
    out["env"] = sorted(str(k) for k in env) if isinstance(env, dict) else env
    headers = server.get("headers")
    out["headers"] = sorted(str(k) for k in headers) if isinstance(headers, dict) else headers
    return out


def _mcp_needs_approval(local: Any, incoming: dict[str, Any]) -> bool:
    if local is None or _mcp_runs(local) != _mcp_runs(incoming):
        return True
    # Switched off here and on elsewhere: turning it back on is asked too.
    if local.get("enabled") is False and incoming.get("enabled", True) is not False:
        return True
    mine, theirs = local.get("env") or {}, incoming.get("env") or {}
    return any(
        mine.get(name) != theirs.get(name) and not _env_rotates(name, mine.get(name), theirs.get(name))
        for name in theirs
    )


def _mcp_valid(servers: list[dict[str, Any]], index: int, incoming: dict[str, Any]) -> bool:
    """Whether the store would take the document with *incoming* in it, and
    an approval could show all of it (``MAX_SYNCED_ENV``, ``MAX_SYNCED_NAME``,
    nothing in what runs that hides what it is, ``_mcp_hides``)."""
    from .mcp_settings import MCPServersDocument

    if mcp_record_problem(incoming):
        return False
    candidate = list(servers)
    if index < 0:
        candidate.append(incoming)
    else:
        candidate[index] = incoming
    try:
        MCPServersDocument(servers=candidate)
    except Exception:  # noqa: BLE001 - any refusal is a refusal
        return False
    return True


def mcp_record_problem(server: dict[str, Any]) -> str:
    """Why an MCP record from elsewhere (sync, a settings bundle) cannot be
    shown whole and as it is, or "": hidden characters in what runs, more
    env entries or headers than an approval shows, a name too long."""
    if _mcp_hides(server):
        return "its command, arguments or URL hide characters"
    for field_name in ("env", "headers"):
        values = server.get(field_name)
        if isinstance(values, dict) and len(values) > MAX_SYNCED_ENV:
            return f"it carries more than {MAX_SYNCED_ENV} {field_name} entries"
        if isinstance(values, dict) and any(len(str(k)) > MAX_SYNCED_NAME for k in values):
            return f"a name in {field_name} is longer than {MAX_SYNCED_NAME} characters"
    return ""


def _mcp_hides(server: dict[str, Any]) -> bool:
    """Whether a synced record's command, args or url hold a character that
    hides what it says (``mcp_settings._has_invisible``)."""
    from .mcp_settings import _has_invisible

    values = [server.get("command"), server.get("url")]
    args = server.get("args")
    if isinstance(args, list):
        values.extend(args)
    return any(isinstance(v, str) and _has_invisible(v) for v in values)


def _mcp_summary(name: str, server: dict[str, Any]) -> dict[str, Any]:
    """What the approval list shows: the whole record — transport, command,
    every arg, url, cwd, every env entry and every header name — with only
    the values of secret-named env entries and of headers masked. Never cut
    and never masked by content: a value that decides what runs is shown as
    it is (a record too large to show is refused, see ``sync_approvals``)."""
    out: dict[str, Any] = {"name": name}
    for key in ("transport", "command", "url", "cwd"):
        if server.get(key) not in (None, ""):
            out[key] = server[key]
    if isinstance(server.get("args"), list):
        out["args"] = list(server["args"])
    env = server.get("env")
    if isinstance(env, dict) and env:
        out["env"] = {str(k): MASKED_VALUE if _env_secret(str(k)) else v for k, v in sorted(env.items())}
    headers = server.get("headers")
    if isinstance(headers, dict) and headers:
        out["headers"] = {str(k): MASKED_VALUE for k in sorted(headers)}
    if server.get("enabled") is False:
        out["enabled"] = False
    return out


#: What a conflict preview shows in place of an MCP env or header value.
MASKED_VALUE = "••••••"
#: The MCP record fields whose values are secrets (settings_bundle blanks the
#: same two on export).
_MCP_SECRET_FIELDS = ("env", "headers")


#: The item id prefix of an install-only MCP record (see ``McpScope``).
INSTALL_PREFIX = "i:"
#: What an install-only record is sealed under on legacy item ids.
INSTALL_SEAL_SCOPE = "mcp-install"


def _server_name(item_id: str) -> str:
    return item_id[len(INSTALL_PREFIX):] if item_id.startswith(INSTALL_PREFIX) else item_id


def _install_only(server: Any) -> Any:
    """An MCP record as it travels: every env and header value empty, the
    names kept, so the far side can tell which fields it has to fill in."""
    if not isinstance(server, dict):
        return server
    out = dict(server)
    for field_name in _MCP_SECRET_FIELDS:
        values = out.get(field_name)
        if isinstance(values, dict):
            out[field_name] = {str(k): "" for k in values}
    return out


def _with_local_values(incoming: dict[str, Any], local: Any) -> dict[str, Any]:
    """*incoming* with whatever values it carried replaced by this machine's
    own for the same names; a name this machine has no value for is empty."""
    out = _install_only(incoming)
    for field_name in _MCP_SECRET_FIELDS:
        values = out.get(field_name)
        have = local.get(field_name) if isinstance(local, dict) else None
        if not isinstance(values, dict) or not isinstance(have, dict):
            continue
        out[field_name] = {k: have[k] if isinstance(have.get(k), str) else "" for k in values}
    return out


def _mask_mcp(payload: Any) -> Any:
    if not isinstance(payload, dict):
        return payload
    out = dict(payload)
    for field_name in _MCP_SECRET_FIELDS:
        values = out.get(field_name)
        if isinstance(values, dict):
            out[field_name] = {str(k): MASKED_VALUE for k in values}
    return out


def _masked_diff(local: Any, remote: Any) -> dict[str, dict[str, str]]:
    """Per masked field, whether each value is the same on both sides:
    ``same``, ``differs``, ``local-only`` or ``remote-only``. Said here, from
    the real values, because two masked halves otherwise look identical."""
    out: dict[str, dict[str, str]] = {}
    for field_name in _MCP_SECRET_FIELDS:
        mine = local.get(field_name) if isinstance(local, dict) else None
        theirs = remote.get(field_name) if isinstance(remote, dict) else None
        mine = mine if isinstance(mine, dict) else {}
        theirs = theirs if isinstance(theirs, dict) else {}
        if not mine and not theirs:
            continue
        out[field_name] = {
            str(key): (
                "local-only" if key not in theirs
                else "remote-only" if key not in mine
                else "same" if mine[key] == theirs[key]
                else "differs"
            )
            for key in sorted(set(mine) | set(theirs), key=str)
        }
    return out


def conflict_preview(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Conflict rows as a window may show them: MCP env and header values
    masked, names kept, and ``masked`` saying per name whether the two values
    are the same (``_masked_diff``). The rows themselves
    (``SyncStore.conflict_payloads``) keep the real values, which ``resolve``
    writes back."""
    out: list[dict[str, Any]] = []
    for row in rows:
        if row.get("scope") == McpScope.scope and not row.get("sealed"):
            local, remote = row.get("local"), row.get("remote")
            row = {**row, "local": _mask_mcp(local), "remote": _mask_mcp(remote),
                   "masked": _masked_diff(local, remote)}
        out.append(row)
    return out


#: Where a synced skill decision waits when the skill itself is not here yet.
SKILLS_INTENT_KEY = "sync-skills-intent"


def skill_entry(store: Any, skill: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """One skill's sync item, and whether its files were too large to carry.

    A record over the engine's body limit is skipped whole, which would take
    the enabled/targets decision down with the files. So the size is checked
    here, on the sealed body the engine will build, and an entry that would
    not fit goes without its content instead.
    """
    name = skill["name"]
    entry: dict[str, Any] = {
        "enabled": bool(skill.get("enabled", True)),
        "targets": skill.get("targets"),
    }
    try:
        content = store.export_content(name)
    except Exception as err:  # noqa: BLE001 - an unreadable skill still routes
        log.warning("the files of %s could not be read: %s", name, err)
        return entry, False
    if content is None:
        # export_content also answers None for a skill that is not ours.
        return entry, bool(skill.get("managed")) and skill.get("valid", True) is not False
    body = sync_keyring.sealed_length(sync_engine.canonical({**entry, "content": content}))
    if body > sync_engine.MAX_BODY_BYTES:
        log.warning("skill %s is too large to sync whole; sending only its settings", name)
        return entry, True
    entry["content"] = content
    return entry, False


def annotate_content_sync(listing: dict[str, Any], store: Any) -> dict[str, Any]:
    """Mark each managed skill whose files stay on this device (``sync_too_large``).

    When the server can hold blobs, those skills' files do travel — as blobs —
    so they are marked ``sync_via_blobs`` instead, with any transfer in flight
    under ``sync_transfer``.
    """
    blobs = skill_files_scope()
    via_blobs = blobs.available()
    for skill in listing.get("skills", []):
        name = skill.get("name")
        if skill.get("managed") and isinstance(name, str) and name:
            too_large = skill_entry(store, skill)[1]
            skill["sync_too_large"] = too_large and (not via_blobs or name in blobs.oversized())
            if too_large and via_blobs and not skill["sync_too_large"]:
                skill["sync_via_blobs"] = True
                transfer = blobs.transfer(name)
                if transfer is not None:
                    skill["sync_transfer"] = transfer
    return listing


class SkillsStateScope:
    """Which skills are on, which CLIs each one goes to, and — for the ones
    Navide created — the files themselves.

    Content rides in the same item rather than a scope of its own, because a
    skill's files and the decision about that skill are one thing to the person
    looking at it: turning Skills sync on should not leave them with a list of
    names they cannot open.

    Only skills carrying the ``.navide`` marker send content. A shared-root
    entry the user put there themselves is listed and routed like any other,
    but its files stay where they are — see ``SkillsStore.export_content``.

    A decision can still arrive for a skill this machine does not have (its
    sender did not own the files either), which is why it is kept twice: once
    applied to the store, and once in ``SKILLS_INTENT_KEY`` for the rest.

    Without the second copy the snapshot would simply lack that item on the
    next round, the engine would read the absence as a delete, and one machine
    missing a skill would switch it off for every machine that has it.

    Routes are the user's intent, not this machine's result: a device with no
    codex installed keeps "send it to codex" on file, inert, and honours it the
    day codex arrives.
    """

    scope = "skills"

    def _store(self):
        from . import app

        return app.skills_store

    def _intent(self) -> dict[str, Any]:
        raw = _settings().get().get(SKILLS_INTENT_KEY)
        return dict(raw) if isinstance(raw, dict) else {}

    def _set_intent(self, intent: dict[str, Any]) -> None:
        _settings().set({SKILLS_INTENT_KEY: intent})

    def _present(self) -> dict[str, Any]:
        store = self._store()
        try:
            listing = store.list_skills()
        except Exception as err:  # noqa: BLE001 - an unreadable library syncs nothing
            log.warning("the skills library could not be read: %s", err)
            return {}
        out: dict[str, Any] = {}
        for skill in listing.get("skills", []):
            name = skill.get("name")
            if not (isinstance(name, str) and name):
                continue
            out[name] = skill_entry(store, skill)[0]
        return out

    def snapshot(self) -> dict[str, Any]:
        # What is here wins over what was remembered for it; the remembered
        # entries survive for the skills this machine does not hold. A record
        # waiting for approval stands in for the local one (sync_approvals).
        return without_detached(self.scope, sync_approvals.overlay(self.scope, self._local()))

    def withheld(self) -> list[str]:
        """Rejected records whose held copy no longer opens: nothing goes up
        for them (``sync_approvals.withheld``)."""
        return sync_approvals.withheld(self.scope)

    def approval_local(self, item_id: str) -> Any | None:
        """This machine's copy of *item_id* as a hold is filed against it
        (``_local``, detached or not): what ``decide`` compares, so a skill
        re-added elsewhere after a delete there can still be approved here."""
        return self._local().get(item_id)

    def local_snapshot(self) -> dict[str, Any]:
        """The skills this machine actually has (and remembers), approvals
        aside — what a settings bundle may offer."""
        return without_detached(self.scope, self._local())

    def _local(self) -> dict[str, Any]:
        return {**self._intent(), **self._present()}

    def apply(self, item_id: str, payload: Any | None) -> bool:
        """Take one record in. False means this machine refused it and holds
        nothing for it: a record that is not an object, or files that would
        not land (the name is the user's own skill here, or a path is unsafe)."""
        intent = self._intent()
        if payload is None:
            sync_approvals.drop(self.scope, item_id)
            intent.pop(item_id, None)
            self._set_intent(intent)
            # The files stay (see ``detach``); they just stop syncing.
            detach(self.scope, item_id, self._present().get(item_id))
            return True
        if not isinstance(payload, dict):
            log.warning("skill decision %s arrived as %s", item_id, type(payload).__name__)
            return False
        decision = {
            "enabled": bool(payload.get("enabled", True)),
            "targets": payload.get("targets"),
        }
        store = self._store()
        content = payload.get("content")
        if isinstance(content, dict):
            gate = self._approval_gate(store, item_id, payload, content)
            if gate != "write":
                return gate == "held"
        gate = self._decision_gate(item_id, payload, decision)
        if gate != "write":
            return gate == "held"
        if isinstance(content, dict):
            # Files first: a decision recorded for files that did not land
            # would snapshot as an entry without them, and pushing that up
            # erases them from the cloud.
            try:
                landed = bool(store.import_content(item_id, content))
            except Exception as err:  # noqa: BLE001 - a refused write is not fatal
                log.warning("the files of %s were not written: %s", item_id, err)
                landed = False
            if not landed:
                log.warning("skill %s was not taken in: its files were refused here", item_id)
                return False
        attach(self.scope, item_id)
        intent[item_id] = decision
        self._set_intent(intent)
        if item_id not in self._present():
            return True  # the skill is not here; the decision waits in the intent map
        try:
            store.set_enabled(item_id, decision["enabled"])
            store.set_targets(item_id, decision["targets"])
        except Exception as err:  # noqa: BLE001 - a skill that moved is not fatal
            log.warning("the synced decision for %s could not be applied: %s", item_id, err)
        return True

    def _decision_gate(self, item_id: str, payload: Any, decision: dict[str, Any]) -> str:
        """For a skill this machine has: switching it on when it is off here,
        or sending it to CLIs it does not go to here, is asked — as the same
        change to an MCP server is. Switching off and narrowing are not."""
        local = self._present().get(item_id)
        if local is None or sync_approvals.is_approved(self.scope, item_id, payload):
            return "write"
        turned_on = local.get("enabled") is False and decision["enabled"]
        mine, theirs = local.get("targets"), decision["targets"]
        widened = (isinstance(mine, list) and theirs is None) or (
            isinstance(mine, list) and isinstance(theirs, list) and bool(set(theirs) - set(mine))
        )
        if not (turned_on or widened):
            return "write"
        if sync_approvals.is_rejected(self.scope, item_id, payload):
            return "held"
        held = sync_approvals.hold(
            self.scope, item_id, payload, local=self._local().get(item_id), kind=sync_approvals.KIND_CHANGED,
            summary={
                "name": item_id,
                "enabled": decision["enabled"],
                "targets": theirs,
                "previousEnabled": local.get("enabled"),
                "previousTargets": mine,
            },
        )
        return "held" if held else "refused"

    def _approval_gate(self, store: Any, item_id: str, payload: Any, content: dict[str, Any]) -> str:
        """``write`` when the files may land now: they match this machine's
        copy, or the user approved exactly this record. Otherwise the record
        is held for approval (``held``, also for one rejected before) or, when
        it cannot be held, ``refused``."""
        try:
            if not store.can_import(item_id):
                return "write"  # import_content refuses it; reported as before
            local_content = store.export_content(item_id)
        except Exception:  # noqa: BLE001 - an unreadable copy is no copy
            local_content = None
        if local_content is not None and sync_engine.digest(local_content) == sync_engine.digest(content):
            return "write"
        if sync_approvals.is_approved(self.scope, item_id, payload):
            return "write"
        problem = _skill_paths_problem(content)
        if problem:
            # Paths that are one file here would land as other than shown.
            log.warning("skill %s refused: %s", item_id, problem)
            return "refused"
        if sync_approvals.is_rejected(self.scope, item_id, payload):
            return "held"
        held = sync_approvals.hold(
            self.scope, item_id, payload, local=self._local().get(item_id),
            kind=sync_approvals.KIND_NEW if local_content is None else sync_approvals.KIND_CHANGED,
            summary=_skill_summary(item_id, payload, content),
        )
        return "held" if held else "refused"


#: Characters of SKILL.md, and of each previewed file, an approval shows;
#: past it the preview is cut and says so.
SKILL_PREVIEW_CHARS = 2000
#: Files an approval previews by kind, whatever their mode.
_SCRIPT_SUFFIXES = (".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl",
                    ".ps1", ".bat", ".cmd", ".php", ".lua")


def _skill_file_bytes(entry: Any) -> bytes | None:
    import base64

    if not isinstance(entry, dict) or not isinstance(entry.get("v"), str):
        return None
    try:
        return entry["v"].encode("utf-8") if entry.get("t") == "text" else base64.b64decode(entry["v"])
    except (ValueError, TypeError):
        return None


def _preview(raw: bytes) -> tuple[str, bool]:
    text = raw.decode("utf-8", errors="replace")
    return text[:SKILL_PREVIEW_CHARS], len(text) > SKILL_PREVIEW_CHARS


#: Most characters of SKILL.md frontmatter an approval shows; it is shown
#: whole or the record is refused, since the CLIs act on it (hooks, tools).
MAX_FRONTMATTER_CHARS = 16 * 1024


def _skill_md_name(paths: Any) -> str | None:
    """The path a CLI reads as SKILL.md, compared as a case-insensitive,
    normalising volume would (``Skill.md`` is it) — by the same key the
    path checks use (skills_store._alias_key)."""
    from .skills_store import _alias_key

    want = _alias_key("SKILL.md")
    return next((str(p) for p in sorted(paths, key=str) if _alias_key(str(p)) == want), None)


def _frontmatter(skill_md_text: str) -> dict[str, Any]:
    """SKILL.md's frontmatter, whole, apart from the body, with the keys
    that make a CLI run or allow more named — or a ``truncated`` mark (the
    record is then refused) when it is too long to show whole."""
    from .skills_store import _FRONTMATTER_RE

    # Read as Navide's own parser reads it (skills_store._FRONTMATTER_RE),
    # past a BOM, so the frontmatter shown is the one that takes effect.
    text = skill_md_text[1:] if skill_md_text.startswith("\ufeff") else skill_md_text
    match = _FRONTMATTER_RE.match(text)
    if match is None:
        if text.startswith("---"):
            # Looks like frontmatter but does not parse as Navide's: a CLI
            # with a looser reader might still find one, unseen here.
            return {"truncated": "SKILL.md opens frontmatter that does not parse"}
        return {"frontmatter": "", "frontmatterFlags": []}
    block = match.group("yaml")
    if len(block) > MAX_FRONTMATTER_CHARS:
        return {"truncated": "the SKILL.md frontmatter is too long to show whole"}
    flags = _risky_keys(block)
    if flags is None:
        # Not YAML as a parser reads it: what a CLI makes of it cannot be said.
        return {"truncated": "the SKILL.md frontmatter does not parse as YAML"}
    return {"frontmatter": block, "frontmatterFlags": flags}


def _risky_keys(block: str) -> list[str] | None:
    """hooks / allowed-tools among the frontmatter's keys, as the YAML
    parses them (quoted forms included); None when it is not a YAML mapping
    (an empty frontmatter has no keys)."""
    import yaml

    try:
        parsed = yaml.safe_load(block)
    except yaml.YAMLError:
        return None
    if parsed is None:
        return []
    if not isinstance(parsed, dict):
        return None
    keys = {str(k).strip().lower().replace("_", "-") for k in parsed}
    return sorted(keys & {"hooks", "allowed-tools"})


def _skill_paths_problem(paths: Any) -> str:
    """Why a skill's paths cannot land as shown (aliases, unsafe names), or ""."""
    from .skills_store import SkillValidationError, _validate_bundle_paths

    try:
        _validate_bundle_paths([str(p) for p in paths], portable_names=False)
    except SkillValidationError as err:
        return str(err)
    return ""


def _skill_summary(name: str, payload: dict[str, Any], files: dict[str, Any]) -> dict[str, Any]:
    """What the approval list shows of a held skill: SKILL.md (what the agent
    will be told) and whether its preview was cut, every file with its size
    and SHA-256, and a preview — cut with a flag past ``SKILL_PREVIEW_CHARS``
    — of every file SKILL.md names and every script (by mode, shebang or
    extension), plus the routing it asks for."""
    import hashlib

    decoded = {str(rel): _skill_file_bytes(entry) for rel, entry in files.items()}
    skill_md_path = _skill_md_name(decoded)
    skill_md_raw = (decoded.get(skill_md_path) if skill_md_path else None) or b""
    skill_md, skill_md_cut = _preview(skill_md_raw)
    skill_md_text = skill_md_raw.decode("utf-8", errors="replace")
    rows: list[dict[str, Any]] = []
    previews: list[dict[str, Any]] = []
    executable: list[str] = []
    for rel in sorted(decoded):
        raw = decoded[rel]
        if raw is None:
            continue
        rows.append({"path": rel, "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()})
        entry = files.get(rel)
        marked = _EXEC_BITS and isinstance(entry, dict) and bool(entry.get("x"))
        if marked:
            executable.append(rel)
        if rel == skill_md_path:
            continue
        if marked or rel.lower().endswith(_SCRIPT_SUFFIXES) or raw[:2] == b"#!" or rel in skill_md_text:
            text, cut = _preview(raw)
            previews.append({"path": rel, "preview": text, "truncated": cut, "executable": marked})
    return {
        "name": name,
        "files": rows,
        "skillMd": skill_md,
        "skillMdTruncated": skill_md_cut,
        **_frontmatter(skill_md_text),
        "previews": previews,
        "executable": executable,
        "enabled": bool(payload.get("enabled", True)),
        "targets": payload.get("targets"),
    }


#: Manifest format of a ``skill-files`` record.
_MANIFEST_VERSION = 1
#: How often a running transfer tells the windows how far it got.
_PROGRESS_INTERVAL_S = 0.5
#: Most bytes a large skill may download to be reviewed before approval;
#: past it the record is held but cannot be approved.
MAX_REVIEW_BYTES = 64 * 1024 * 1024
#: Most bytes the sealed review copies of all held large skills may take;
#: a review past it waits for space (a hold decided frees its copies).
MAX_REVIEW_CACHE_BYTES = 512 * 1024 * 1024
#: The ``unavailable`` of a held large skill whose review download is due,
#: and the start of one waiting for space in the review cache.
REVIEW_PENDING = "downloading its files for review"
REVIEW_NO_SPACE = "waiting for space to download its files for review"
#: Failed downloads of one manifest before its record is given up on. Until
#: then the record holds the scope's cursor; after, it is declined (reported
#: by ``SkillFilesScope.failed``) so the records behind it can land.
MAX_DOWNLOAD_ATTEMPTS = 3


class SkillFilesScope:
    """The files of skills too large for one ``skills`` record, as blobs.

    ``skills`` still carries every skill's settings; for the skills whose
    content it has to leave out (``skill_entry`` says too large), this scope
    carries a manifest — each file's path, blob id, key id, size — and the
    files themselves travel as blobs (``skill_blobs``) straight between this
    machine and object storage.

    A scope of its own, never a field on ``skills``: a build that predates
    blobs would store such an entry without the field and push it back, and
    the manifest would be silently erased. Old builds never pull this scope.

    Transfers never run inside a sync round. ``ready`` answers whether every
    blob of an item is already on the server, and starts an upload when not;
    ``apply`` lands a manifest only once every file is here, and otherwise
    starts the download and defers (the engine holds the cursor on it). Either
    transfer kicks one more round when it finishes. A round therefore stays
    short however large the files are, and the other scopes do not wait.

    Removal is not propagated: a tombstone drops the record, never files, the
    same rule ``skills`` follows.
    """

    scope = "skill-files"

    def __init__(self, notify: Callable[[dict[str, Any]], None] | None = None) -> None:
        self._notify = notify
        self._layout: Any = None
        self._request: Any = None
        self._kick: Callable[[], None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._tasks: dict[str, asyncio.Task[Any]] = {}
        self._transfers: dict[str, dict[str, Any]] = {}
        self._last_note: dict[str, float] = {}
        self._digests: Any = None
        #: Skills naming more blobs than one record may (``Layout.max_refs``):
        #: held here, never pushed, and listed as too large to sync.
        self._oversized: set[str] = set()
        #: Failed downloads, by item: (manifest digest, count). A new
        #: manifest for the item starts the count again.
        self._download_failures: dict[str, tuple[str, int]] = {}
        #: Bytes of review downloads started and not yet sealed, by item:
        #: counted against MAX_REVIEW_CACHE_BYTES with what is on disk.
        self._review_reserved: dict[str, int] = {}
        self._temps_cleaned = False

    # ── wiring ──────────────────────────────────────────────────────────

    def set_notify(self, notify: Callable[[dict[str, Any]], None] | None) -> None:
        self._notify = notify

    def available(self) -> bool:
        """Whether the server this machine last spoke to can hold blobs."""
        return self._layout is not None

    def reset(self) -> None:
        """Forget what the last account left: running transfers (cancelled),
        their progress, give-ups and too-large marks. For an account change;
        the next round asks the server about blobs afresh."""
        for task in list(self._tasks.values()):
            if not task.done():
                _call_on_loop(self._loop, task.cancel)
        self._tasks.clear()
        self._transfers.clear()
        self._last_note.clear()
        self._download_failures.clear()
        self._oversized.clear()
        self._layout = None

    def withheld(self) -> list[str]:
        """Rejected records whose held copy no longer opens: nothing goes up
        for them (``sync_approvals.withheld``)."""
        return sync_approvals.withheld(self.scope)

    def failed(self) -> list[str]:
        """Skills whose files were given up on after repeated failed downloads."""
        return sorted(
            name for name, (_d, count) in self._download_failures.items() if count >= MAX_DOWNLOAD_ATTEMPTS
        )

    def oversized(self) -> list[str]:
        """Skills whose files are too many for one record, as of the last round."""
        return sorted(self._oversized)

    def transfer(self, name: str) -> dict[str, Any] | None:
        entry = self._transfers.get(name)
        return dict(entry) if entry else None

    async def prepare(self, request: Any, kick: Callable[[], None]) -> bool:
        """Called by the engine at the start of each round, on the loop."""
        from . import skill_blobs

        self._request, self._kick, self._loop = request, kick, asyncio.get_running_loop()
        if not self._temps_cleaned:
            # Once per process: plaintext a crash left mid-review or mid-land.
            self._temps_cleaned = True
            await asyncio.to_thread(sync_approvals.clean_leftover_temps, self._staging())
        try:
            self._layout = await skill_blobs.server_layout(request)
        except skill_blobs.BlobError as err:
            log.warning("the server's blob storage could not be asked about: %s", err)
            self._layout = None
        if self._layout is not None:
            # Approved skills whose files had to download first land now, and
            # held ones whose review download has not run yet start it.
            await asyncio.to_thread(sync_approvals.land_approved, self)
            for item_id in await asyncio.to_thread(self._reviews_due):
                payload = await asyncio.to_thread(sync_approvals.held_payload, self.scope, item_id)
                if payload is not None:
                    self._start_review(item_id, payload)
        return self._layout is not None

    def _reviews_due(self) -> list[str]:
        out = []
        for row in sync_approvals.listing():
            unavailable = str(row["summary"].get("unavailable") or "")
            if row["scope"] == self.scope and row["status"] == sync_approvals.PENDING and (
                unavailable == REVIEW_PENDING or unavailable.startswith(REVIEW_NO_SPACE)
            ):
                out.append(row["itemId"])
        return out

    def _review_space(self, item_id: str, total: int) -> bool:
        """Whether a review of *total* bytes fits the review cache now."""
        reserved = sum(v for k, v in self._review_reserved.items() if k != item_id)
        return sync_approvals.review_cache_bytes() + reserved + total <= MAX_REVIEW_CACHE_BYTES

    def _store(self):
        from . import app

        return app.skills_store

    def _digest_cache(self):
        if self._digests is None:
            from . import app, skill_blobs

            self._digests = skill_blobs.DigestCache(app.database)
        return self._digests

    def _staging(self):
        from . import app

        path = app.app_data_dir() / "skill-blobs"
        path.mkdir(parents=True, exist_ok=True)
        return path

    # ── what is here ────────────────────────────────────────────────────

    def _large_skills(self) -> dict[str, dict[str, Any]]:
        """Managed skills whose files ``skills`` leaves out, by name → files."""
        store = self._store()
        try:
            listing = store.list_skills()
        except Exception as err:  # noqa: BLE001 - an unreadable library syncs nothing
            log.warning("the skills library could not be read: %s", err)
            return {}
        out: dict[str, dict[str, Any]] = {}
        for skill in listing.get("skills", []):
            name = skill.get("name")
            if not (isinstance(name, str) and name and skill.get("managed")):
                continue
            if not skill_entry(store, skill)[1]:
                continue
            try:
                files = store.list_files(name)
            except Exception as err:  # noqa: BLE001 - one unreadable skill is skipped
                log.warning("the files of %s could not be listed: %s", name, err)
                continue
            if files:
                out[name] = files
        return out

    def _manifest(self, files: dict[str, Any]) -> dict[str, Any]:
        cache = self._digest_cache()
        entries: dict[str, Any] = {}
        for relative, path in sorted(files.items()):
            entry = cache.ref_for(path).to_manifest()
            if self._is_executable(path):
                entry["x"] = True
            entries[relative] = entry
        return {"v": _MANIFEST_VERSION, "files": entries}

    def _is_executable(self, path: Any) -> bool:
        if _EXEC_BITS:
            return bool(path.stat().st_mode & 0o111)
        # No mode bit to read: keep the flag a synced file landed with, and
        # take a script written here by its shebang, so neither is dropped
        # for the devices that can run it.
        if self._digest_cache().is_executable(path):
            return True
        with open(path, "rb") as fh:
            return fh.read(2) == b"#!"

    def snapshot(self) -> dict[str, Any]:
        if self._layout is None:
            return {}
        return without_detached(self.scope, sync_approvals.overlay(self.scope, self._manifests()))

    def _manifests(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for name, files in self._large_skills().items():
            try:
                out[name] = self._manifest(files)
            except (OSError, sync_keyring.KeyringError) as err:
                log.warning("skill %s could not be named for sync: %s", name, err)
        return out

    @staticmethod
    def _refs_of(payload: Any) -> dict[str, Any]:
        """``relative path → BlobRef`` of a manifest; raises BlobError when malformed."""
        from . import skill_blobs

        if not isinstance(payload, dict) or payload.get("v") != _MANIFEST_VERSION:
            raise skill_blobs.BlobError("not a skill-files manifest this build reads")
        files = payload.get("files")
        if not isinstance(files, dict) or not files:
            raise skill_blobs.BlobError("the manifest lists no files")
        return {str(rel): skill_blobs.BlobRef.from_manifest(entry) for rel, entry in files.items()}

    def refs(self, payload: Any) -> list[str]:
        return sorted({ref.blob_id for ref in self._refs_of(payload).values()})

    # ── transfers ───────────────────────────────────────────────────────

    def _progress(self, name: str, direction: str) -> Callable[[int, int], None]:
        def report(done: int, total: int) -> None:
            self._transfers[name] = {"direction": direction, "done": done, "total": total}
            now = time.monotonic()
            if done < total and now - self._last_note.get(name, 0.0) < _PROGRESS_INTERVAL_S:
                return
            self._last_note[name] = now
            self._announce(name)

        return report

    def _announce(self, name: str) -> None:
        if self._notify is None or self._loop is None:
            return
        payload = {"name": name, "transfer": self.transfer(name)}
        self._loop.call_soon_threadsafe(self._notify, payload)

    def _finish(self, name: str) -> None:
        self._transfers.pop(name, None)
        self._tasks.pop(name, None)
        self._announce(name)

    def _start(self, name: str, work: Callable[[], Any]) -> None:
        """Run *work* (a coroutine factory) for *name* unless one already runs. Loop only."""
        if name in self._tasks and not self._tasks[name].done():
            return

        async def run() -> None:
            try:
                await work()
            except Exception as err:  # noqa: BLE001 - retried by the next round
                log.warning("the files of skill %s did not transfer: %s", name, err)
                self._finish(name)
                return
            self._finish(name)
            if self._kick is not None:
                self._kick()

        self._tasks[name] = asyncio.get_running_loop().create_task(run())

    async def ready(self, item_id: str, payload: Any) -> bool:
        """Whether every blob *payload* names is on the server; starts the upload when not."""
        from . import skill_blobs

        if self._layout is None:
            return False
        refs = self._refs_of(payload)
        blob_ids = sorted({r.blob_id for r in refs.values()})
        if len(blob_ids) > self._layout.max_refs:
            # The server refuses the record outright. It stays in the
            # snapshot (absence would read as a delete) and is said to be too
            # large, rather than retried every round.
            if item_id not in self._oversized:
                log.warning(
                    "skill %s has %d distinct files; one record may name %d, so its files stay here",
                    item_id, len(blob_ids), self._layout.max_refs,
                )
            self._oversized.add(item_id)
            return False
        self._oversized.discard(item_id)
        states: list[Any] = []
        try:
            for start in range(0, len(blob_ids), skill_blobs.STAT_BATCH):
                reply = skill_blobs._payload(
                    await self._request("blobs.stat", {"blobIds": blob_ids[start:start + skill_blobs.STAT_BATCH]})
                )
                states.extend(reply.get("blobs") or [])
        except skill_blobs.BlobError as err:
            # This item waits; the rest of the round goes ahead.
            log.warning("could not ask which files of %s are uploaded: %s", item_id, err)
            return False
        missing = {b["blobId"] for b in states if b.get("state") != "complete"}
        if not missing:
            return True
        files = self._store().list_files(item_id) or {}
        layout, request = self._layout, self._request
        todo = [(files[rel], ref) for rel, ref in refs.items() if ref.blob_id in missing and rel in files]
        total = sum(layout.sealed_size(ref.size) for _, ref in todo)

        async def upload() -> None:
            done = 0
            seen: set[str] = set()
            report = self._progress(item_id, "upload")
            for path, ref in todo:
                if ref.blob_id in seen:
                    continue
                seen.add(ref.blob_id)
                base = done
                await skill_blobs.upload(request, path, ref, layout, progress=lambda d, _t: report(base + d, total))
                done = base + layout.sealed_size(ref.size)

        self._start(item_id, upload)
        return False

    def apply(self, item_id: str, payload: Any | None) -> Any:
        """Land a manifest's files, or defer until they are downloaded. Worker thread."""
        from . import skill_blobs

        if payload is None:
            sync_approvals.drop(self.scope, item_id)
            # A removal elsewhere never deletes files here (see ``detach``).
            if self._layout is not None:
                detach(self.scope, item_id, self._manifests().get(item_id))
            return None
        attach(self.scope, item_id)
        try:
            refs = self._refs_of(payload)
        except skill_blobs.BlobError as err:
            log.warning("skill-files record %s was not applied: %s", item_id, err)
            return False
        store = self._store()
        if not store.can_import(item_id):
            log.warning("skill %s exists here and is not Navide's; its synced files are not fetched", item_id)
            return False
        local_manifest = self._manifests().get(item_id) if self._layout is not None else None
        if sync_approvals.is_approved(self.scope, item_id, payload):
            return self._land_reviewed(item_id, payload, refs)
        if self._needs_review(local_manifest, payload) and _skill_paths_problem(refs):
            log.warning("skill-files %s refused: %s", item_id, _skill_paths_problem(refs))
            return False
        if self._needs_review(local_manifest, payload):
            # New or changed files. They are downloaded into the hold area,
            # sealed, to be shown before approval (``_review``); nothing lands
            # until then, and only what was shown lands after.
            if sync_approvals.is_rejected(self.scope, item_id, payload):
                return True
            total = sum(ref.size for ref in refs.values())
            if total > MAX_REVIEW_BYTES:
                unavailable = f"too large to review here: {total} bytes, the limit is {MAX_REVIEW_BYTES}"
            elif not self._review_space(item_id, total):
                unavailable = f"{REVIEW_NO_SPACE} (decide the skills already waiting to free it)"
            else:
                unavailable = REVIEW_PENDING
            summary: dict[str, Any] = {
                "name": item_id,
                "files": [{"path": rel, "size": refs[rel].size} for rel in sorted(refs)],
                "bytes": total,
                "unavailable": unavailable,
            }
            held = sync_approvals.hold(
                self.scope, item_id, payload, local=local_manifest,
                kind=sync_approvals.KIND_NEW if local_manifest is None else sync_approvals.KIND_CHANGED,
                summary=summary,
            )
            if held and unavailable == REVIEW_PENDING and self._loop is not None and not self._loop.is_closed():
                self._review_reserved[item_id] = total
                self._loop.call_soon_threadsafe(self._start_review, item_id, payload)
            return held
        manifest_digest = sync_engine.digest(payload)
        failure = self._download_failures.get(item_id)
        if failure is not None and failure[0] != manifest_digest:
            self._download_failures.pop(item_id, None)
        elif failure is not None and failure[1] >= MAX_DOWNLOAD_ATTEMPTS:
            log.warning(
                "the files of skill %s failed to download %d times; giving up on this version",
                item_id, failure[1],
            )
            return False
        staging = self._staging()
        current = {}
        try:
            current = store.list_files(item_id) or {}
        except Exception:  # noqa: BLE001 - not ours, or absent: nothing to reuse
            current = {}
        sources: dict[str, Any] = {}
        wanted: dict[str, Any] = {}
        for rel, ref in refs.items():
            here = current.get(rel)
            if here is not None:
                try:
                    if self._digest_cache().ref_for(here).blob_id == ref.blob_id:
                        sources[rel] = here
                        continue
                except (OSError, sync_keyring.KeyringError):
                    pass
            cached = staging / ref.blob_id
            if cached.is_file():
                sources[rel] = cached
            else:
                wanted[ref.blob_id] = ref
        if wanted:
            if self._layout is None or self._loop is None or self._loop.is_closed():
                raise sync_engine.DeferItem(item_id)
            layout, request = self._layout, self._request
            refs_todo = list(wanted.values())
            total = sum(layout.sealed_size(ref.size) for ref in refs_todo)

            async def download() -> None:
                done = 0
                report = self._progress(item_id, "download")
                try:
                    for ref in refs_todo:
                        base = done
                        await skill_blobs.download(
                            request, ref, staging / ref.blob_id, layout,
                            progress=lambda d, _t: report(base + d, total),
                        )
                        done = base + layout.sealed_size(ref.size)
                except Exception:
                    previous = self._download_failures.get(item_id)
                    count = previous[1] + 1 if previous and previous[0] == manifest_digest else 1
                    self._download_failures[item_id] = (manifest_digest, count)
                    raise
                self._download_failures.pop(item_id, None)

            self._loop.call_soon_threadsafe(self._start, item_id, download)
            raise sync_engine.DeferItem(item_id)

        executable = {rel for rel, entry in payload["files"].items() if isinstance(entry, dict) and entry.get("x")}
        landed = store.import_files(item_id, sources, executable=executable)
        for source in sources.values():
            if source.parent == staging:
                source.unlink(missing_ok=True)
        if not landed:
            return False
        if not _EXEC_BITS:
            for rel, path in (store.list_files(item_id) or {}).items():
                self._digest_cache().set_executable(path, rel in executable)
        # The settings arrived through ``skills`` and may have been waiting in
        # the intent map for these files; without applying them now, the next
        # ``skills`` snapshot would read the defaults off the fresh copy.
        decision = SkillsStateScope()._intent().get(item_id)
        if isinstance(decision, dict):
            try:
                store.set_enabled(item_id, bool(decision.get("enabled", True)))
                store.set_targets(item_id, decision.get("targets"))
            except Exception as err:  # noqa: BLE001 - a decision that will not apply is not fatal
                log.warning("the synced decision for %s could not be applied: %s", item_id, err)
        return True


    # ── review before approval ──────────────────────────────────────────

    @staticmethod
    def _needs_review(local_manifest: Any, payload: Any) -> bool:
        """Whether a manifest brings files this machine does not have as-is."""
        return local_manifest is None or sync_engine.digest(local_manifest) != sync_engine.digest(payload)

    def _start_review(self, item_id: str, payload: Any) -> None:
        """Start downloading a held record's files for review. Loop only."""
        if self._layout is None or self._request is None:
            return
        running = self._tasks.get(f"review:{item_id}")
        if running is not None and not running.done():
            # Its files are on disk and its summary is landing: the space
            # check would count them against it and mark it waiting.
            return
        layout, request = self._layout, self._request
        payload_digest = sync_engine.digest(payload)
        try:
            total = sum(ref.size for ref in self._refs_of(payload).values())
        except Exception:  # noqa: BLE001 - reported by the review below
            total = 0
        if not self._review_space(item_id, total):
            note = {"name": item_id, "files": [], "unavailable":
                    f"{REVIEW_NO_SPACE} (decide the skills already waiting to free it)"}
            sync_approvals.update_summary(self.scope, item_id, payload_digest, note)
            self._review_reserved.pop(item_id, None)
            return
        self._review_reserved[item_id] = total

        async def review() -> None:
            try:
                refs = self._refs_of(payload)
                await self._fetch_for_review(item_id, payload_digest, refs, layout, request)
                summary = await asyncio.to_thread(self._review_summary, item_id, payload, payload_digest, refs)
            except Exception as err:  # noqa: BLE001 - said on the card, not raised
                log.warning("the files of %s could not be fetched for review: %s", item_id, err)
                sync_approvals.drop_held_files(self.scope, item_id, payload_digest)
                summary = {
                    "name": item_id,
                    "files": [],
                    "unavailable": f"its files could not be downloaded for review: {err}",
                }
            finally:
                self._review_reserved.pop(item_id, None)
            await asyncio.to_thread(sync_approvals.update_summary, self.scope, item_id, payload_digest, summary)

        self._start(f"review:{item_id}", review)

    async def _fetch_for_review(
        self, item_id: str, payload_digest: str, refs: dict[str, Any], layout: Any, request: Any
    ) -> None:
        """Download every file of a held record, verify it, and seal it into
        the hold area under its path. The plaintext exists only as a
        temporary file beside the sealed ones while it is sealed."""
        from . import skill_blobs

        directory = sync_approvals._private_dir(sync_approvals._held_files_dir(self.scope, item_id, payload_digest))
        fetched: dict[str, Any] = {}
        try:
            for rel, ref in sorted(refs.items()):
                temp = fetched.get(ref.blob_id)
                if temp is None:
                    temp = directory / f"fetch-{ref.blob_id}.tmp"
                    # download() appends to <temp>.part and renames it into
                    # place: created 0600 here, it keeps that mode.
                    sync_approvals.private_file(temp.with_name(temp.name + ".part"))
                    await skill_blobs.download(request, ref, temp, layout)
                    fetched[ref.blob_id] = temp
                await asyncio.to_thread(
                    sync_approvals.seal_held_file, self.scope, item_id, payload_digest, rel, temp
                )
        finally:
            for temp in fetched.values():
                temp.unlink(missing_ok=True)
            for leftover in directory.glob("fetch-*"):
                leftover.unlink(missing_ok=True)

    def _review_summary(
        self, item_id: str, payload: Any, payload_digest: str, refs: dict[str, Any]
    ) -> dict[str, Any]:
        """The summary of a reviewed large skill, read back from the sealed
        copies: what ``_skill_summary`` shows of a small one."""
        import hashlib

        rows: list[dict[str, Any]] = []
        previews: list[dict[str, Any]] = []
        shas: dict[str, str] = {}
        for rel in sorted(refs):
            sha = hashlib.sha256()
            size = 0
            for segment in sync_approvals._held_file_segments(self.scope, item_id, payload_digest, rel):
                sha.update(segment)
                size += len(segment)
            shas[rel] = sha.hexdigest()
            rows.append({"path": rel, "size": size, "sha256": shas[rel]})
        skill_md_path = _skill_md_name(refs)
        skill_md_raw, _ = sync_approvals.held_file_head(
            self.scope, item_id, payload_digest, skill_md_path, 1024 * 1024
        ) if skill_md_path else (b"", False)
        skill_md, skill_md_cut = _preview(skill_md_raw)
        skill_md_text = skill_md_raw.decode("utf-8", errors="replace")
        files = payload.get("files") if isinstance(payload, dict) else {}
        executable = sorted(
            rel for rel, e in (files or {}).items() if _EXEC_BITS and isinstance(e, dict) and e.get("x")
        )
        for rel in sorted(refs):
            if rel == skill_md_path:
                continue
            head, more = sync_approvals.held_file_head(
                self.scope, item_id, payload_digest, rel, SKILL_PREVIEW_CHARS * 4
            )
            marked = rel in executable
            if marked or rel.lower().endswith(_SCRIPT_SUFFIXES) or head[:2] == b"#!" or rel in skill_md_text:
                text, cut = _preview(head)
                previews.append({"path": rel, "preview": text, "truncated": cut or more, "executable": marked})
        return {
            "name": item_id,
            "files": rows,
            "skillMd": skill_md,
            "skillMdTruncated": skill_md_cut,
            **_frontmatter(skill_md_text),
            "previews": previews,
            "executable": executable,
            "bytes": sum(r["size"] for r in rows),
        }

    def _land_reviewed(self, item_id: str, payload: Any, refs: dict[str, Any]) -> bool:
        """Land an approved record from the copies that were reviewed, each
        checked against the SHA-256 the approval showed. Worker thread. False
        (nothing written) when any is missing, does not open, or differs."""
        store = self._store()
        payload_digest = sync_engine.digest(payload)
        summary = sync_approvals.held_summary(self.scope, item_id) or {}
        shown = {f.get("path"): f.get("sha256") for f in summary.get("files") or [] if isinstance(f, dict)}
        # Plaintext copies to land from, private, beside the sealed ones.
        staging = sync_approvals._private_dir(sync_approvals._held_files_dir(self.scope, item_id, payload_digest))
        sources: dict[str, Any] = {}
        try:
            for rel in sorted(refs):
                dest = staging / ("review-" + sync_approvals._file_label(self.scope, item_id, payload_digest, rel))
                sources[rel] = dest
                sha = sync_approvals.open_held_file(self.scope, item_id, payload_digest, rel, dest)
                if not shown.get(rel) or sha != shown[rel]:
                    log.warning("skill %s: %s is not the file that was reviewed; nothing lands", item_id, rel)
                    return False
            executable = {
                rel for rel, entry in payload["files"].items() if isinstance(entry, dict) and entry.get("x")
            }
            landed = store.import_files(item_id, sources, executable=executable)
        except Exception as err:  # noqa: BLE001 - a reviewed copy that will not open lands nothing
            log.warning("skill %s: the reviewed files could not be landed: %s", item_id, err)
            return False
        finally:
            for source in sources.values():
                source.unlink(missing_ok=True)
        if not landed:
            return False
        sync_approvals.drop_held_files(self.scope, item_id, payload_digest)
        if not _EXEC_BITS:
            for rel, path in (store.list_files(item_id) or {}).items():
                self._digest_cache().set_executable(path, rel in executable)
        decision = SkillsStateScope()._intent().get(item_id)
        if isinstance(decision, dict):
            try:
                store.set_enabled(item_id, bool(decision.get("enabled", True)))
                store.set_targets(item_id, decision.get("targets"))
            except Exception as err:  # noqa: BLE001 - a decision that will not apply is not fatal
                log.warning("the synced decision for %s could not be applied: %s", item_id, err)
        return True


_skill_files: SkillFilesScope | None = None


def skill_files_scope() -> SkillFilesScope:
    """The one ``skill-files`` adapter: the engine registers it and the skills
    listing reads its transfer state, so both must see the same instance."""
    global _skill_files
    if _skill_files is None:
        _skill_files = SkillFilesScope()
    return _skill_files


#: The characters a memory item id keeps as they are; the protocol's itemId
#: pattern (``^[A-Za-z0-9._:@+-]{1,200}$``) allows these plus ``:@+``.
_MEMORY_ID_PLAIN = re.compile(r"[A-Za-z0-9._-]")
_MEMORY_ID_MAX = 200


def memory_item_id(relative: str) -> str:
    """The wire id of the instruction file at ``relative`` (to the home).

    ``/`` becomes ``:``, and every other character outside ``[A-Za-z0-9._-]``
    — ``:``, ``@`` and ``+`` included — becomes ``+XX`` per UTF-8 byte, so the
    mapping is one-to-one and ``.claude/CLAUDE.md`` still reads as
    ``.claude:CLAUDE.md``. An id that would pass the protocol's 200-character
    limit is ``@sha256:`` and a digest of the path instead. Ids are only ever matched against
    this machine's own candidates (``MemoryScope._resolve``), never decoded.
    """
    out: list[str] = []
    for ch in relative:
        if ch == "/":
            out.append(":")
        elif _MEMORY_ID_PLAIN.fullmatch(ch):
            out.append(ch)
        else:
            out.extend(f"+{b:02X}" for b in ch.encode("utf-8"))
    encoded = "".join(out)
    if len(encoded) <= _MEMORY_ID_MAX:
        return encoded
    import hashlib

    # "@" never appears in an encoded path (it is escaped as +40), so a digest
    # id cannot collide with one.
    return "@sha256:" + hashlib.sha256(relative.encode("utf-8")).hexdigest()


class MemoryScope:
    """User-scope instruction files — ``~/.claude/CLAUDE.md`` and its siblings.

    Project scope is excluded by construction, not by a flag: those files are
    inside the user's repository and git is already their source of truth. Two
    systems writing one file is how both of them end up wrong.

    The item id is the path *relative to the home directory*, so the same file
    is the same item on a machine whose home is somewhere else entirely —
    encoded by ``memory_item_id``, because the protocol refuses a ``/`` in an
    id. ``snapshot_by_path`` keeps the plain paths for the settings bundle.
    """

    scope = "memory"

    def __init__(self, *, gate: bool = True) -> None:
        #: False for a caller that already showed the user this very record
        #: (a settings-bundle import): nothing is held for approval then.
        self._gate = gate
        #: mtime of each file as the last snapshot read it, by absolute path:
        #: ``apply`` refuses to write over a file that has moved on since.
        self._read_mtimes: dict[str, float] = {}
        #: Items over the record limit, as of the last snapshot. They stay in
        #: the snapshot — absence would read as a delete — and are listed here.
        self._oversized: set[str] = set()

    def oversized(self) -> list[str]:
        """Item ids too large for one record, as of the last snapshot."""
        return sorted(self._oversized)

    def _files(self) -> dict[str, Any]:
        from . import native_memory

        return {
            f.relative: f
            for f in native_memory.scan()
            if f.scope == native_memory.USER_SCOPE and f.exists and not f.error
            and _declared(f.readers)
            # A directory, a FIFO or a link to one reads as "" — which would
            # go up as an edit and empty the file on every other device.
            and os.path.isfile(f.path)
        }

    def snapshot(self) -> dict[str, Any]:
        # A record waiting for approval stands in for the local file
        # (sync_approvals), so the engine pushes nothing over it.
        return without_detached(self.scope, sync_approvals.overlay(self.scope, self.local_snapshot()))

    def local_snapshot(self) -> dict[str, Any]:
        """The files this machine actually has, by wire id, approvals aside."""
        return {memory_item_id(rel): payload for rel, payload in self.snapshot_by_path().items()}

    def snapshot_by_path(self) -> dict[str, Any]:
        """``snapshot``, keyed by the path relative to the home."""
        from . import native_memory

        out: dict[str, Any] = {}
        oversized: set[str] = set()
        mtimes: dict[str, float] = {}
        for relative, entry in self._files().items():
            try:
                doc = native_memory.read(entry.path)
            except Exception as err:  # noqa: BLE001 - skip what cannot be read
                log.warning("instruction file %s could not be read: %s", relative, err)
                continue
            text = doc.get("text")
            if not doc.get("exists") or not _strict_utf8(entry.path):
                # Not a file after all, or not UTF-8: the editor shows it with
                # replacement characters, but sending that would replace the
                # real bytes everywhere else.
                log.warning("instruction file %s is not a readable UTF-8 file; not syncing it", relative)
                continue
            if isinstance(text, str):
                out[relative] = {"text": text}
                if isinstance(doc.get("modified"), (int, float)):
                    mtimes[str(entry.path)] = float(doc["modified"])
                if _over_record_limit(out[relative]):
                    oversized.add(memory_item_id(relative))
        # A file absent from this snapshot is absent from the map too, so an
        # earlier mtime cannot refuse a file that was deleted and comes back.
        self._read_mtimes = mtimes
        self._oversized = oversized
        return out

    def apply(self, item_id: str, payload: Any | None) -> bool:
        """Write one record in. False means this machine refused it and does
        not hold it — no known file there, or the write failed — which the
        engine must not read as agreement."""
        from . import native_memory

        # A delete is never carried through to the user's disk. Removing an
        # instruction file is not the kind of thing one machine should do to
        # another unprompted, and the file is the user's, not ours.
        if payload is None:
            log.info("keeping instruction file %s here; it was deleted on another device", item_id)
            present = {memory_item_id(rel): p for rel, p in self.snapshot_by_path().items()}
            detach(self.scope, item_id, present.get(item_id))
            return True
        if not isinstance(payload, dict) or not isinstance(payload.get("text"), str):
            log.warning("instruction file %s arrived without text", item_id)
            return False
        target = self._resolve(item_id)
        if target is None:
            log.warning("no known instruction file matches %s on this machine", item_id)
            return False
        if target not in self._read_mtimes and os.path.lexists(target):
            # There is a file here the snapshot could not read (over the
            # editor's size limit, unreadable): the engine never saw it, so
            # writing would replace it unseen.
            log.warning("instruction file %s exists here but could not be read; not overwriting it", item_id)
            return False
        if self._gate and not sync_approvals.is_approved(self.scope, item_id, payload):
            local = self.local_snapshot().get(item_id)
            if local is None or sync_engine.digest(local) != sync_engine.digest(payload):
                # New here or different: an instruction file is what every
                # agent reads before it starts, so it waits for the user
                # (decision S2). Up to the memory scope's own size limit.
                if len(payload["text"].encode("utf-8")) > native_memory.FILE_SIZE_LIMIT:
                    log.warning("instruction file %s is over the size limit; refused", item_id)
                    return False
                if sync_approvals.is_rejected(self.scope, item_id, payload):
                    return True
                return sync_approvals.hold(
                    self.scope, item_id, payload, local=local,
                    kind=sync_approvals.KIND_NEW if local is None else sync_approvals.KIND_CHANGED,
                    summary={"path": _home_relative(target), "bytes": len(payload["text"].encode("utf-8"))},
                )
        try:
            # Against the mtime the snapshot read: an editor save in between
            # is refused rather than overwritten, and the next round sees it
            # as the local edit it is.
            saved = native_memory.save(
                target, payload["text"], expected_modified=self._read_mtimes.get(target)
            )
        except Exception as err:  # noqa: BLE001 - a refused write is not fatal
            log.warning("the synced instruction file %s was not written: %s", item_id, err)
            return False
        if isinstance(saved, dict) and isinstance(saved.get("modified"), (int, float)):
            self._read_mtimes[target] = float(saved["modified"])
        attach(self.scope, item_id)
        return True

    @staticmethod
    def _resolve(relative: str) -> str | None:
        """The absolute path this machine keeps ``relative`` at, if it knows one.

        ``relative`` is a wire id (``memory_item_id``) or, from a settings
        bundle, the plain path.
        """
        from . import native_memory

        for path, (scope, rel, readers, _canonical) in native_memory.candidates().items():
            if scope != native_memory.USER_SCOPE or not _declared(readers):
                continue
            if relative in (rel, memory_item_id(rel)):
                return str(path)
        return None


def _home_relative(path: str) -> str:
    from pathlib import Path

    home = str(Path.home())
    return "~" + path[len(home):] if path.startswith(home + os.sep) else path


def _present_memory(item_id: str, payload: Any, summary: dict[str, Any]) -> dict[str, Any]:
    """A held instruction file, whole, with a diff against this machine's."""
    import difflib

    text = payload["text"]
    local = MemoryScope().local_snapshot().get(item_id)
    mine = local["text"] if isinstance(local, dict) and isinstance(local.get("text"), str) else ""
    diff = "".join(difflib.unified_diff(
        mine.splitlines(keepends=True), text.splitlines(keepends=True),
        "this device", "incoming", n=3,
    ))
    return {**summary, "text": text, "diff": diff}


def _successor_fields(skills: list[dict[str, Any]], item_id: str) -> dict[str, Any]:
    """Which prompt would become the default — the loop prompt — were
    *item_id* deleted from *skills*: its name and id, or None for both."""
    rest = _single_default([s for s in skills if s.get("id") != item_id])
    successor = next((s for s in rest if s.get("isDefault")), None)
    if successor is None:
        return {"newLoopPrompt": None, "newLoopPromptId": None}
    return {"newLoopPrompt": str(successor.get("name") or successor.get("id")), "newLoopPromptId": successor.get("id")}


def _present_prompt(item_id: str, payload: Any, summary: dict[str, Any]) -> dict[str, Any]:
    """A held prompt, every field, with what differs from this machine's.
    A held delete shows as itself, with the prompt that would become the
    loop prompt worked out now, from this machine's list as it is: what the
    card shows is kept (``persist``) so approval can be refused if it moves."""
    if payload == sync_approvals.DELETE_PAYLOAD:
        now = _successor_fields(PromptsScope()._list(), item_id)
        return {**summary, **now, "persist": now}
    record = {k: v for k, v in payload.items() if k != "id"} if isinstance(payload, dict) else {}
    local = PromptsScope().local_snapshot().get(item_id)
    changes = []
    if isinstance(local, dict):
        for field_name in sorted(set(record) | {k for k in local if k != "id"}):
            if local.get(field_name) != record.get(field_name):
                changes.append({"field": field_name, "from": local.get(field_name), "to": record.get(field_name)})
    return {**summary, "record": record, "changes": changes}


sync_approvals.register_presenter("memory", _present_memory)
sync_approvals.register_presenter("prompts", _present_prompt)


def _strict_utf8(path: Any) -> bool:
    try:
        with open(path, "rb") as fh:
            fh.read().decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return False
    return True


def _over_record_limit(payload: Any) -> bool:
    """Whether the engine's sealed body for *payload* would pass its limit."""
    try:
        return sync_keyring.sealed_length(sync_engine.canonical(payload)) > sync_engine.MAX_BODY_BYTES
    except Exception:  # noqa: BLE001 - no key: nothing goes up anyway
        return False


def _declared(readers: Any) -> bool:
    """Whether a file is in the table rather than only named by an aider
    ``read:`` entry. Those entries can point anywhere under the home — a
    project file included — and syncing one would copy it into another
    machine's home. The editor still lists them; sync leaves them alone."""
    return bool(set(readers) - {"aider"})


def on_account_changed() -> None:
    """Signing out or switching the cloud account.

    The engine's record of every scope is dropped, then every scope is
    switched off: what this machine's user wrote stays here, and goes up to
    the new account only once they turn a section on again. Sync is opt-in per account, not per install.

    All scopes, not only credentials: the agreed state, cursor and conflicts
    are not keyed by account, so the previous account's revs would otherwise
    be pushed against the next one's server as edits of rows it never had,
    and every never-synced item here would be uploaded to it unasked.

    Fails closed: the switches go off first, every later step is attempted
    even when one before it failed, and any failure is raised at the end so
    the caller records the switch as unfinished and tries again.
    """
    from . import app

    failures: list[str] = []

    def attempt(what: str, step: Callable[[], Any]) -> None:
        try:
            step()
        except Exception as err:  # noqa: BLE001 - collected, raised below
            log.warning("account change: could not %s: %s", what, err)
            failures.append(f"{what}: {err}")

    attempt(
        "switch the sync scopes off",
        lambda: _settings().set({SCOPES_SETTING: {scope: False for scope in sync_engine.SCOPES}}),
    )
    # Rounds still running for the previous account write nothing from here on.
    attempt("retire the running rounds", app.sync_store.new_generation)
    for scope in sync_engine.SCOPES + sync_engine.INTERNAL_SCOPES:
        attempt(f"forget {scope}", lambda scope=scope: app.sync_store.forget(scope))
    attempt("forget detached marks", forget_detached)
    # Items waiting for the user's approval (D1) arrived under the previous
    # account too, sealed under its key.
    attempt("forget pending approvals", forget_approvals)
    reset = getattr(_skill_files, "reset", None)
    if reset is not None:
        attempt("reset the skill files transfers", reset)
    if failures:
        raise sync_engine.SyncError("; ".join(failures))


def switch_account(previous: str | None, namespace: str | None) -> None:
    """An account change that keeps each account's sync bookkeeping (D4).

    *previous*'s agreed state, cursors, conflicts, pending approvals and
    detached marks are parked under it, ``on_account_changed`` lets go of
    everything else exactly as before (every scope switched off), and
    *namespace*'s parked bookkeeping comes back, so switching back resumes
    rather than reading the account again from the start.

    The parts move together or not at all: a held approval whose agreed
    state came back without it would let the older local copy be pushed over
    the record waiting for approval. Whatever cannot be parked or restored
    is let go of instead — the pre-v4 behaviour, a fresh read, never a wrong one.
    """
    from . import app

    store = app.sync_store
    store.new_generation()
    if previous:
        try:
            if not sync_approvals.park_approvals(previous):
                raise OSError("the pending approvals have nowhere to be parked")
            store.park_account(previous)
            detached = _settings().get().get(DETACHED_KEY)
            # None on a retried switch: the first attempt parked the marks,
            # and parking "none" would overwrite them.
            if detached is not None:
                store.park_value(previous, DETACHED_KEY, detached)
        except Exception as err:  # noqa: BLE001 - fall back to letting go
            log.warning("account change: could not park the sync state; it will be read afresh: %s", err)
            _discard_parked(store, previous)
    on_account_changed()
    if namespace:
        _restore_parked(store, namespace)


def _discard_parked(store: Any, account: str) -> None:
    """Let go of everything parked for *account*, and of its live rows, so
    the account is read afresh — never restored as state without its holds."""
    try:
        sync_approvals.discard_parked_approvals(account)
        # Bringing the parked rows back live is what takes them out of the
        # parking table; ``on_account_changed`` then forgets every live row.
        store.restore_account(account)
        store.take_parked_value(account, DETACHED_KEY)
    except Exception as err:  # noqa: BLE001 - the forget that follows still runs
        log.warning("account change: could not discard the parked sync state: %s", err)


def _restore_parked(store: Any, namespace: str) -> None:
    try:
        store.restore_account(namespace)
        detached = store.take_parked_value(namespace, DETACHED_KEY)
        if detached:
            _settings().set({DETACHED_KEY: detached})
        sync_approvals.restore_approvals(namespace)
    except Exception as err:  # noqa: BLE001 - fall back to a fresh read
        log.warning("account change: could not restore the sync state; reading afresh: %s", err)
        for scope in sync_engine.SCOPES + sync_engine.INTERNAL_SCOPES:
            store.forget(scope)
        forget_detached()
        forget_approvals()


def _live_is_empty(store: Any) -> bool:
    scopes = sync_engine.SCOPES + sync_engine.INTERNAL_SCOPES
    return not store.conflicts(None) and not any(store.states(s) or store.cursor(s) for s in scopes)


def adopt_account(namespace: str | None) -> None:
    """The link settled on *namespace* without a switch it could see.

    Usually the live rows are already that account's and are only claimed.
    After a sign-out, though, nothing was settled, and the next sign-in looks
    like a first one: if nothing is live, whatever was parked for this
    account when it signed out comes back."""
    from . import app

    store = app.sync_store
    if namespace and _live_is_empty(store):
        _restore_parked(store, namespace)
        return
    store.adopt_account(namespace)


def forget_detached(scope: str | None = None) -> None:
    """Drop the detached marks of *scope*, or of every scope.

    They describe items of the account they were made under, so they go when
    that account does and when a scope is read again from the start.
    """
    raw = _settings().get().get(DETACHED_KEY)
    if not raw:
        return
    if scope is None or not isinstance(raw, dict):
        _settings().set({DETACHED_KEY: None})
        return
    if scope not in raw:
        return
    rest = {k: v for k, v in raw.items() if k != scope}
    _settings().set({DETACHED_KEY: rest or None})


#: Secret warnings the user dismissed, as ``{scope: {item_id: digest}}``: a
#: dismissal holds until the item changes.
SECRET_DISMISSED_KEY = "sync-secret-dismissed"
#: Prompt fields scanned for something that reads like a credential.
_PROMPT_TEXT_FIELDS = ("prompt", "resumePrompt", "description")
_MAX_WARNING_LINES = 5


def _looks_secret(value: Any) -> bool:
    from .settings_bundle import _SECRET_HINT_RE

    return isinstance(value, str) and bool(_SECRET_HINT_RE.search(value))


def secret_warnings() -> list[dict[str, Any]]:
    """Items of an enabled prompts, memory or MCP scope that look like they
    carry a secret (decision D2): a warning to show before they sync, never a
    block and never a strip. Reuses the settings bundle's heuristic.

    Each is ``{scope, itemId, label, fields, lines?}``: where, never what.
    MCP env and header values are not scanned: they are expected secrets and
    travel sealed. A warning the user dismissed stays away until the item
    changes."""
    from .settings_bundle import CARRIED_FIELDS

    # What a round actually syncs: a retired scope's switch may still be on.
    enabled = {scope: scope_enabled(scope) for scope in sync_engine.SCOPES}
    raw = _settings().get().get(SECRET_DISMISSED_KEY)
    dismissed = raw if isinstance(raw, dict) else {}
    out: list[dict[str, Any]] = []

    def add(scope: str, item_id: str, label: str, payload: Any, fields: list[str], **extra: Any) -> None:
        if not fields:
            return
        seen = dismissed.get(scope) if isinstance(dismissed.get(scope), dict) else {}
        if seen.get(item_id) == sync_engine.digest(payload):
            return
        out.append({"scope": scope, "itemId": item_id, "label": label, "fields": fields, **extra})

    if enabled.get("prompts"):
        for item_id, skill in sorted(PromptsScope().local_snapshot().items()):
            fields = [f for f in _PROMPT_TEXT_FIELDS if _looks_secret(skill.get(f))]
            add("prompts", item_id, str(skill.get("name") or item_id), skill, fields)
    if enabled.get("memory"):
        for relative, doc in sorted(MemoryScope().snapshot_by_path().items()):
            text = doc.get("text") if isinstance(doc, dict) else None
            if not _looks_secret(text):
                continue
            lines = [n for n, line in enumerate(str(text).splitlines(), 1) if _looks_secret(line)]
            add("memory", memory_item_id(relative), relative, doc, ["text"],
                lines=lines[:_MAX_WARNING_LINES])
    if enabled.get("mcp"):
        for name, server in sorted(McpScope().local_snapshot().items()):
            fields = []
            for field_name in CARRIED_FIELDS:
                value = server.get(field_name)
                parts = value if isinstance(value, list) else [value]
                if any(_looks_secret(part) for part in parts):
                    fields.append(field_name)
            add("mcp", name, name, server, fields)
    return out


def dismiss_secret_warning(scope: str, item_id: str) -> None:
    """The user saw the warning for this item as it is now and let it sync."""
    current: Any = None
    if scope == "prompts":
        current = PromptsScope().local_snapshot().get(item_id)
    elif scope == "memory":
        current = MemoryScope().local_snapshot().get(item_id)
    elif scope == "mcp":
        current = McpScope().local_snapshot().get(item_id)
    if current is None:
        return
    raw = _settings().get().get(SECRET_DISMISSED_KEY)
    doc = dict(raw) if isinstance(raw, dict) else {}
    entries = dict(doc.get(scope) or {}) if isinstance(doc.get(scope), dict) else {}
    entries[item_id] = sync_engine.digest(current)
    doc[scope] = entries
    _settings().set({SECRET_DISMISSED_KEY: doc})


def forget_approvals(scope: str | None = None) -> None:
    """Drop the records waiting for approval (``sync_approvals``) of *scope*,
    or of every scope; on_account_changed calls it, since they are sealed
    under the previous account's key."""
    sync_approvals.forget_approvals(scope)
