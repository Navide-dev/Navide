"""CredentialWatcher: notice a CLI sign-in that happened outside Navide and
re-point the active-account ledger at it.

Two halves are exercised. The watcher half is the de-noising gate: credential
files sit in directories that churn (``~/.claude.json`` is Claude Code's whole
config), so a file event must only lead somewhere when the account identity
actually changed. The reconcile half moves ``defaults[agentKey]`` — and nothing
else: no credential is captured, restored, swapped or cleared, and the account
switch rate limit is not consumed, because nothing was switched.
"""

from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app, ws_handlers
from agent_team_backend.credential_watcher import (
    CredentialWatcher,
    _watch_targets,
    reconcile_live_account,
)
from agent_team_backend.profiles_store import CliProfilesStore


def test_watch_targets_follow_kilo_xdg_path(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    home = tmp_path / "home"
    targets = _watch_targets(home, ("kilo", "codex"))
    assert targets == {
        tmp_path / "xdg" / "kilo": {"auth.json": "kilo"},
        home / ".codex": {"auth.json": "codex"},
    }


def _codex_auth(email: str) -> str:
    """A codex auth.json whose id_token JWT payload carries ``email`` — the
    shape ``cli_vendors.codex.identity_from_secret`` reads."""
    payload = base64.urlsafe_b64encode(
        json.dumps({"email": email}).encode()
    ).decode().rstrip("=")
    return json.dumps({"tokens": {"access_token": "tok", "id_token": f"h.{payload}.s"}})


@pytest.fixture()
def store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> CliProfilesStore:
    s = CliProfilesStore(
        path=tmp_path / "cli-profiles.json",
        profiles_root=tmp_path / "cli-profiles",
    )
    monkeypatch.setattr(app, "cli_profiles_store", s)
    return s


@pytest.fixture()
def events(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = []

    async def record(event: dict[str, Any], *, exclude: Any = None) -> None:
        sent.append(event)

    monkeypatch.setattr(app, "broadcast", record)
    return sent


@pytest.fixture()
def codex_live(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Write codex's live auth.json in the vault's (tmp) real home."""
    # File mode: the conftest security runner always reports 'not found', so
    # the claude Keychain path stays inert for the other agents' reads too.
    monkeypatch.setattr(app.credential_vault, "_platform", "linux")
    live_dir = tmp_path / "vault-home" / ".codex"
    live_dir.mkdir(parents=True, exist_ok=True)

    def write(email: str) -> None:
        (live_dir / "auth.json").write_text(_codex_auth(email), encoding="utf-8")

    return write


def _write_slot(agent_key: str, slot_id: str, secret: str) -> None:
    slot = app.credential_vault.slot_dir(agent_key, slot_id)
    slot.mkdir(parents=True, exist_ok=True)
    (slot / "auth.json").write_text(secret, encoding="utf-8")


def _forbid_credential_writes(
    monkeypatch: pytest.MonkeyPatch, allow: tuple[str, ...] = ()
) -> None:
    """Reconciliation corrects bookkeeping only — the live credentials already
    belong to the account it aligns to. Any vault call that MOVES a credential
    is a bug, so make them all fail loudly. ``allow`` exempts the slot-only
    calls a test expects (registering an unknown account harvests into its new
    slot, which never writes the live state)."""
    def refuse(name: str):
        def _call(*_args: Any, **_kwargs: Any) -> None:
            raise AssertionError(f"reconcile must not call credential_vault.{name}")
        return _call

    for name in (
        "switch", "capture", "restore", "clear_live", "write_live", "write_slot",
        "harvest", "harvest_login_home", "delete_slot_secrets",
    ):
        if name not in allow:
            monkeypatch.setattr(app.credential_vault, name, refuse(name))


# ---- watcher: de-noising ---------------------------------------------------


async def test_identical_fingerprint_is_not_reported(tmp_path: Path) -> None:
    """A credential file rewritten without an account change (token refresh,
    config churn) must not reach the sink; a genuine change must."""
    home = tmp_path / "home"
    (home / ".codex").mkdir(parents=True)
    live = home / ".codex" / "auth.json"
    live.write_text("{}", encoding="utf-8")

    fired: list[str] = []

    async def sink(agent_key: str) -> None:
        fired.append(agent_key)

    identity = {"codex": ("a@example.com", True)}
    watcher = CredentialWatcher(
        sink,
        real_home=home,
        agent_keys=("codex",),
        fingerprint=lambda key: identity[key],
        debounce_s=0.1,
        poll_s=0.05,
    )
    watcher.start()
    try:
        await asyncio.sleep(0.2)  # let the startup seeding land
        live.write_text('{"tokens": {"access_token": "refreshed"}}', encoding="utf-8")
        await asyncio.sleep(0.4)
        assert fired == []

        identity["codex"] = ("b@example.com", True)
        live.write_text('{"tokens": {"access_token": "other-account"}}', encoding="utf-8")
        await asyncio.sleep(0.4)
        assert fired == ["codex"]
    finally:
        watcher.stop()


async def test_unrelated_file_in_a_watched_dir_is_ignored(tmp_path: Path) -> None:
    """Only the credential file names matter — the directories around them
    (the home dir, ~/.claude) are written by everything."""
    home = tmp_path / "home"
    (home / ".codex").mkdir(parents=True)

    fired: list[str] = []

    async def sink(agent_key: str) -> None:
        fired.append(agent_key)

    watcher = CredentialWatcher(
        sink,
        real_home=home,
        agent_keys=("codex",),
        fingerprint=lambda key: ("changed-every-time", object()),
        debounce_s=0.1,
        poll_s=0.05,
    )
    watcher.start()
    try:
        await asyncio.sleep(0.2)
        (home / ".codex" / "history.jsonl").write_text("x", encoding="utf-8")
        (home / "unrelated.txt").write_text("x", encoding="utf-8")
        await asyncio.sleep(0.4)
        assert fired == []
    finally:
        watcher.stop()


async def test_missing_credential_dirs_do_not_break_start(tmp_path: Path) -> None:
    """A CLI that was never installed has no directory to watch; startup must
    survive that (all four agents are watched, most users have one or two)."""
    home = tmp_path / "empty-home"
    home.mkdir()

    async def sink(_agent_key: str) -> None:  # pragma: no cover - never called
        raise AssertionError("nothing should fire")

    watcher = CredentialWatcher(sink, real_home=home, debounce_s=0.1)
    watcher.start()
    await asyncio.sleep(0.1)
    watcher.stop()


def _claude_home(tmp_path: Path) -> Path:
    home = tmp_path / "home"
    (home / ".claude" / "projects").mkdir(parents=True)
    (home / ".claude.json").write_text("{}", encoding="utf-8")
    return home


async def _wait_for(fired: list[str], timeout: float = 4.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not fired and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)


async def test_no_filesystem_watch_is_rooted_at_home_or_claude_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An FSEvents stream covers its whole subtree whatever `recursive` says,
    and the extension behind it leaks per event (#144) — a stream on $HOME
    for ~/.claude.json took in every file change on the machine, and one on
    ~/.claude every transcript write."""
    from watchdog.observers.api import BaseObserver

    roots: list[str] = []
    real_schedule = BaseObserver.schedule

    def spy(self, handler, path, *args, **kwargs):  # noqa: ANN001
        roots.append(str(Path(path).resolve()))
        return real_schedule(self, handler, path, *args, **kwargs)

    monkeypatch.setattr(BaseObserver, "schedule", spy)
    home = _claude_home(tmp_path)

    async def sink(_agent_key: str) -> None:  # pragma: no cover - never called
        pass

    watcher = CredentialWatcher(sink, real_home=home, debounce_s=0.1)
    watcher.start()
    try:
        await asyncio.sleep(0.1)
    finally:
        watcher.stop()
    broad = {str(home.resolve()), str((home / ".claude").resolve())}
    assert broad.isdisjoint(roots), roots


@pytest.mark.parametrize("atomic", [False, True], ids=["rewrite", "atomic-rename"])
async def test_claude_json_change_still_reaches_the_identity_sink(
    tmp_path: Path, atomic: bool
) -> None:
    home = _claude_home(tmp_path)
    identity = {"claude": "a@example.com"}
    fired: list[str] = []

    async def sink(agent_key: str) -> None:
        fired.append(agent_key)

    watcher = CredentialWatcher(
        sink, real_home=home, agent_keys=("claude",),
        fingerprint=lambda key: identity[key], debounce_s=0.1,
    )
    watcher.start()
    try:
        await asyncio.sleep(0.3)  # let the startup seeding land
        identity["claude"] = "b@example.com"
        config = home / ".claude.json"
        if atomic:
            tmp = home / ".claude.json.tmp"
            tmp.write_text('{"oauthAccount": {"emailAddress": "b@example.com"}}', encoding="utf-8")
            tmp.replace(config)
        else:
            config.write_text('{"oauthAccount": {"emailAddress": "b@example.com"}}', encoding="utf-8")
        await _wait_for(fired)
        assert fired == ["claude"]
    finally:
        watcher.stop()


# ---- reconcile -------------------------------------------------------------


async def test_reconcile_moves_default_to_the_matching_slot(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    codex_live,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    work = store.create(agent_key="codex", name="Work")
    personal = store.create(agent_key="codex", name="Personal")
    store.set_default("codex", work["id"])
    _write_slot("codex", work["id"], _codex_auth("work@example.com"))
    _write_slot("codex", personal["id"], _codex_auth("personal@example.com"))
    # The user ran `codex login` in a plain terminal and picked the other one.
    codex_live("personal@example.com")
    _forbid_credential_writes(monkeypatch)

    await reconcile_live_account("codex")

    assert store.list()["defaults"]["codex"] == personal["id"]
    # Not a switch: the manual-switch budget must stay untouched, or a few
    # external logins would start refusing the user's own switches.
    assert ws_handlers._switch_history.get("codex", []) == []
    changed = [e for e in events if e["type"] == "cli_profiles.changed"]
    assert len(changed) == 1
    payload = changed[0]["payload"]
    assert payload["reason"] == "live_credentials"
    assert payload["agent_key"] == "codex"
    # forced=True makes every window restart its panes of this agent — wrong
    # here, since no credential moved under them.
    assert payload["forced"] is False


async def test_reconcile_registers_an_unknown_account(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    codex_live,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An account no slot holds gets a profile of its own, holding a snapshot
    of the live credentials, and becomes the active one."""
    work = store.create(agent_key="codex", name="Work")
    store.set_default("codex", work["id"])
    _write_slot("codex", work["id"], _codex_auth("work@example.com"))
    codex_live("stranger@example.com")
    # Everything that would MOVE the live credentials is still forbidden — only
    # the slot-only pair the snapshot needs may run.
    _forbid_credential_writes(monkeypatch, allow=("harvest", "write_slot"))

    await reconcile_live_account("codex")

    new_id = store.list()["defaults"]["codex"]
    assert new_id not in (None, work["id"])
    assert app.credential_vault.read_slot("codex", new_id).secret == _codex_auth(
        "stranger@example.com"
    )
    assert ws_handlers._switch_history.get("codex", []) == []
    payload = [e for e in events if e["type"] == "cli_profiles.changed"][0]["payload"]
    assert payload["forced"] is False
    assert [p["id"] for p in payload["profiles"]] == [work["id"], new_id]


async def test_registering_an_unknown_account_never_logs_its_email(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    codex_live,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A11: the backend log names the profile, never the account's email."""
    work = store.create(agent_key="codex", name="Work")
    store.set_default("codex", work["id"])
    _write_slot("codex", work["id"], _codex_auth("work@example.com"))
    codex_live("stranger@example.com")
    caplog.set_level("DEBUG")

    await reconcile_live_account("codex")

    new_id = store.list()["defaults"]["codex"]
    assert new_id in caplog.text
    assert "stranger@example.com" not in caplog.text


async def test_registration_failure_leaves_no_credential_less_profile(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    codex_live,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A profile whose slot stayed empty would log the user out the moment it
    is restored, so a failed snapshot takes the profile back down and the
    ledger keeps naming the profile it named before."""
    work = store.create(agent_key="codex", name="Work")
    store.set_default("codex", work["id"])
    _write_slot("codex", work["id"], _codex_auth("work@example.com"))
    codex_live("stranger@example.com")
    _forbid_credential_writes(monkeypatch)  # harvest raises

    await reconcile_live_account("codex")

    assert [p["id"] for p in store.list()["profiles"]] == [work["id"]]
    assert store.list()["defaults"]["codex"] == work["id"]
    assert [e["type"] for e in events] == ["cli_profiles.changed"]


async def test_an_unidentifiable_live_login_registers_nothing(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """kimi carries no identity field, so its live login can never be told
    apart from any other — there is nothing to name a profile after."""
    monkeypatch.setattr(app.credential_vault, "_platform", "linux")
    live = tmp_path / "vault-home" / ".kimi-code" / "credentials"
    live.mkdir(parents=True)
    (live / "kimi-code.json").write_text('{"access_token": "tok"}', encoding="utf-8")
    parked = store.create(agent_key="kimi", name="Parked")
    store.set_default("kimi", parked["id"])
    _forbid_credential_writes(monkeypatch)

    await reconcile_live_account("kimi")

    assert [p["id"] for p in store.list()["profiles"]] == [parked["id"]]
    assert store.list()["defaults"]["kimi"] == parked["id"]


async def test_an_unmanaged_login_registers_no_profile(
    store: CliProfilesStore,
    events: list[dict[str, Any]],
    codex_live,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The common install: no profiles at all, so the live login IS the
    built-in Default account even though that slot holds no snapshot.
    Registering a profile for it would fire on every untouched install."""
    codex_live("solo@example.com")
    _forbid_credential_writes(monkeypatch)

    await reconcile_live_account("codex")

    assert store.list()["profiles"] == []
    assert store.list()["defaults"].get("codex") is None


# ---- unreadable or torn reads (#144) ----------------------------------------


def _codex_watcher(tmp_path: Path, fingerprint, fired: list[str]) -> tuple[CredentialWatcher, Path]:
    home = tmp_path / "home"
    (home / ".codex").mkdir(parents=True)
    live = home / ".codex" / "auth.json"
    live.write_text("{}", encoding="utf-8")

    async def sink(agent_key: str) -> None:
        fired.append(agent_key)

    watcher = CredentialWatcher(
        sink, real_home=home, agent_keys=("codex",),
        fingerprint=fingerprint, debounce_s=0.1, poll_s=0.05,
    )
    return watcher, live


async def test_an_unreadable_identity_is_retried_not_dropped(tmp_path: Path) -> None:
    """A credential file written once at sign-in changes its stamp once. A read
    that fails then (Keychain hiccup, file mid-write) must be retried; the
    stamp is already consumed, so nothing else would ever look again."""
    reads = {"fail": 0}
    identity = {"codex": ("a@example.com", True)}

    def fingerprint(key: str) -> object:
        if reads["fail"]:
            reads["fail"] -= 1
            raise RuntimeError("keychain temporarily unavailable")
        return identity[key]

    fired: list[str] = []
    watcher, live = _codex_watcher(tmp_path, fingerprint, fired)
    watcher.start()
    try:
        await asyncio.sleep(0.2)
        identity["codex"] = ("b@example.com", True)
        reads["fail"] = 2
        live.write_text(_codex_auth("b@example.com"), encoding="utf-8")
        await _wait_for(fired)
        assert fired == ["codex"]
        assert watcher._fingerprints["codex"] == ("b@example.com", True)
    finally:
        watcher.stop()


async def test_a_torn_read_is_not_taken_for_the_new_identity(tmp_path: Path) -> None:
    """A file caught mid-write parses as signed out. A change is confirmed by a
    second read, so the torn reading is never recorded or reported."""
    script: list[object] = []
    identity = {"codex": ("a@example.com", True)}

    def fingerprint(key: str) -> object:
        return script.pop(0) if script else identity[key]

    fired: list[str] = []
    watcher, live = _codex_watcher(tmp_path, fingerprint, fired)
    watcher.start()
    try:
        await asyncio.sleep(0.2)
        identity["codex"] = ("b@example.com", True)
        script.append((None, False))  # the torn read
        live.write_text(_codex_auth("b@example.com"), encoding="utf-8")
        await _wait_for(fired)
        await asyncio.sleep(0.4)
        assert fired == ["codex"]
        assert watcher._fingerprints["codex"] == ("b@example.com", True)
    finally:
        watcher.stop()


async def test_a_real_sign_out_is_still_reported(tmp_path: Path) -> None:
    """Signing out reads the same on every look, so it is not mistaken for a
    torn read."""
    identity = {"codex": ("a@example.com", True)}
    fired: list[str] = []
    watcher, live = _codex_watcher(tmp_path, lambda key: identity[key], fired)
    watcher.start()
    try:
        await asyncio.sleep(0.2)
        identity["codex"] = (None, False)
        live.unlink()
        await _wait_for(fired)
        assert fired == ["codex"]
        assert watcher._fingerprints["codex"] == (None, False)
    finally:
        watcher.stop()


async def test_identity_checks_of_one_agent_do_not_overlap(tmp_path: Path) -> None:
    """Two overlapping checks could finish out of order and leave the older
    reading recorded."""
    active = {"now": 0, "max": 0}

    def fingerprint(key: str) -> object:
        active["now"] += 1
        active["max"] = max(active["max"], active["now"])
        import time
        time.sleep(0.05)
        active["now"] -= 1
        return ("a@example.com", True)

    fired: list[str] = []
    watcher, _ = _codex_watcher(tmp_path, fingerprint, fired)
    watcher._loop = asyncio.get_running_loop()
    await asyncio.gather(watcher._check("codex"), watcher._check("codex"))
    assert active["max"] == 1


def _claude_vault(tmp_path: Path):
    from agent_team_backend.credential_vault import CredentialVault

    home = tmp_path / "vault-home"
    home.mkdir()
    return CredentialVault(root=tmp_path / "profiles", real_home=home, platform="linux"), home


def test_strict_claude_account_read_tells_torn_json_from_signed_out(tmp_path: Path) -> None:
    vault, home = _claude_vault(tmp_path)
    config = home / ".claude.json"
    assert vault.live_account("claude", strict=True) is None  # no file: signed out
    config.write_text('{"theme": "dark"}', encoding="utf-8")
    assert vault.live_account("claude", strict=True) is None  # no account: signed out
    config.write_text('{"oauthAccount": {"emailAddress": "a@exa', encoding="utf-8")
    with pytest.raises(ValueError):
        vault.live_account("claude", strict=True)
    assert vault.live_account("claude") is None  # the display read never raises


def test_strict_identity_surfaces_a_failed_read(tmp_path: Path, monkeypatch) -> None:
    vault, _ = _claude_vault(tmp_path)

    def failing(*_args, **_kwargs):
        raise RuntimeError("keychain temporarily unavailable")

    monkeypatch.setattr(vault, "read_live", failing)
    assert vault.identity("codex") == {"email": None, "signedIn": False}
    with pytest.raises(RuntimeError):
        vault.identity("codex", strict=True)


async def test_live_fingerprint_raises_while_the_identity_is_unreadable(
    tmp_path: Path, monkeypatch
) -> None:
    from agent_team_backend.credential_watcher import live_identity_fingerprint

    vault, home = _claude_vault(tmp_path)
    monkeypatch.setattr(app, "credential_vault", vault)
    (home / ".claude.json").write_text('{"oauthAccount": {"emailAdd', encoding="utf-8")
    with pytest.raises(ValueError):
        live_identity_fingerprint("claude")
    (home / ".claude.json").unlink()
    assert live_identity_fingerprint("claude") == (None, None)


# ---- a failure never stops the watcher or goes unseen (#144) ----------------


def _unretrieved_task_errors() -> list[dict[str, Any]]:
    """Collect what asyncio reports about task exceptions nobody retrieved."""
    seen: list[dict[str, Any]] = []
    asyncio.get_running_loop().set_exception_handler(lambda _loop, ctx: seen.append(ctx))
    return seen


async def _collect_garbage() -> None:
    import gc

    await asyncio.sleep(0)
    gc.collect()
    await asyncio.sleep(0)


async def test_the_poll_survives_a_failed_round(tmp_path: Path, monkeypatch) -> None:
    from agent_team_backend import credential_watcher

    identity = {"codex": ("a@example.com", True)}
    fired: list[str] = []
    watcher, live = _codex_watcher(tmp_path, lambda key: identity[key], fired)
    watcher.start()
    try:
        await asyncio.sleep(0.2)
        real_stamp = credential_watcher._stamp
        failures = {"left": 1}

        def flaky_stamp(path: Path):
            if failures["left"]:
                failures["left"] -= 1
                raise RuntimeError("stat round failed")
            return real_stamp(path)

        monkeypatch.setattr(credential_watcher, "_stamp", flaky_stamp)
        await asyncio.sleep(0.2)
        identity["codex"] = ("b@example.com", True)
        live.write_text(_codex_auth("b@example.com"), encoding="utf-8")
        await _wait_for(fired)
        assert failures["left"] == 0
        assert fired == ["codex"]
    finally:
        watcher.stop()


async def test_stopping_still_cancels_the_poll(tmp_path: Path) -> None:
    watcher, _ = _codex_watcher(tmp_path, lambda key: ("a@example.com", True), [])
    watcher.start()
    poll = watcher._poll_task
    await asyncio.sleep(0.1)
    watcher.stop()
    with pytest.raises(asyncio.CancelledError):
        await poll


async def test_a_failing_identity_sink_is_logged_not_lost(tmp_path: Path, caplog) -> None:
    seen = _unretrieved_task_errors()
    identity = {"codex": ("a@example.com", True)}
    calls: list[str] = []

    async def sink(agent_key: str) -> None:
        calls.append(agent_key)
        raise RuntimeError("broadcast failed")

    home = tmp_path / "home"
    (home / ".codex").mkdir(parents=True)
    live = home / ".codex" / "auth.json"
    live.write_text("{}", encoding="utf-8")
    watcher = CredentialWatcher(
        sink, real_home=home, agent_keys=("codex",),
        fingerprint=lambda key: identity[key], debounce_s=0.1, poll_s=0.05,
    )
    watcher.start()
    try:
        await asyncio.sleep(0.2)
        identity["codex"] = ("b@example.com", True)
        live.write_text(_codex_auth("b@example.com"), encoding="utf-8")
        await _wait_for(calls)
        await asyncio.sleep(0.1)
        await _collect_garbage()
    finally:
        watcher.stop()
    assert calls == ["codex"]
    assert seen == []
    assert "broadcast failed" in caplog.text


async def test_reconcile_survives_a_failed_broadcast(
    store: CliProfilesStore,
    codex_live,
    monkeypatch: pytest.MonkeyPatch,
    caplog,
) -> None:
    codex_live("solo@example.com")

    async def failing_broadcast(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError("socket gone")

    monkeypatch.setattr(ws_handlers, "_broadcast_profiles_changed", failing_broadcast)
    await reconcile_live_account("codex")
    assert "socket gone" in caplog.text
