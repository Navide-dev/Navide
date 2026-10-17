"""Per-pane /plan-mcp caller tokens.

Every pane spawn is wired with a credential bound to that pane id, and
_resolve_caller accepts a pane caller only when the token is the one minted
for the pane id it presents. Before this, one token was shared by every pane
of a backend run, so anything that could read one pane's wiring could present
itself as any other pane (`pane=<victim>` with the shared token).

Tokens are taken from real spawn wiring (wire_command) rather than from a
wiring helper, so these tests say what a CLI process actually holds.
"""

from __future__ import annotations

import io
import logging
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, log_redaction
from agent_team_backend.cli_vendors import registry
from agent_team_backend.mcp_server import auth as plan_mcp_auth, pane_home, server as plan_mcp
from agent_team_backend.mcp_server import wiring as plan_mcp_wiring

PORT = 4567
_TOKEN_IN_URL = re.compile(r"[?&]t=([^&\"'\s]+)")


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    # Tokens are per backend run (module state): start each test with none,
    # so "never wired" means never wired by this test.
    agent_messaging._reset_for_test()
    plan_mcp_wiring._PANE_TOKENS.clear()
    yield
    agent_messaging._reset_for_test()
    plan_mcp_wiring._PANE_TOKENS.clear()


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A fake home for the shim vendors, so no test touches the real one."""
    fake = tmp_path / "home"
    fake.mkdir()
    for agent in pane_home.SHIM_SPECS:
        spec = pane_home.SHIM_SPECS[agent]
        if getattr(spec, "vendor_dir", ""):
            (fake / spec.vendor_dir).mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(pane_home, "real_home", lambda: fake)
    return fake


def _ctx(params: dict[str, str], headers: dict[str, str] | None = None) -> Any:
    request = SimpleNamespace(query_params=params, headers=headers or {})
    return SimpleNamespace(request_context=SimpleNamespace(request=request))


def _codex_spawn_token(pane_id: str) -> str:
    """The credential a codex spawn of ``pane_id`` carries in its env."""
    env: dict[str, str] = {}
    plan_mcp_wiring.wire_command("codex", "codex", PORT, pane_id, env)
    return env[plan_mcp_wiring.TOKEN_ENV]


def _spawn_tokens(agent: str, pane_id: str, cwd: Path) -> set[str]:
    """Every credential a spawn of ``agent`` for ``pane_id`` hands its CLI:
    in the command, the env, and every config file the wiring wrote for it."""
    env: dict[str, str] = {}
    config_dir = plan_mcp_wiring.pane_config_dir()
    before = set(config_dir.glob("*")) if config_dir.exists() else set()
    command = plan_mcp_wiring.wire_command(agent, agent, PORT, pane_id, env, str(cwd))
    texts = [str(command), *env.values()]
    if config_dir.exists():
        for path in config_dir.glob("*"):
            if path not in before or str(path) in str(command):
                texts.append(path.read_text(encoding="utf-8"))
    if agent in pane_home.SHIM_SPECS:
        root = pane_home.shim_root(agent, pane_id)
        assert root is not None
        for path in Path(root).rglob("*"):
            if path.is_file() and not path.is_symlink():
                texts.append(path.read_text(encoding="utf-8", errors="replace"))
    found = {match for text in texts for match in _TOKEN_IN_URL.findall(text)}
    if plan_mcp_wiring.TOKEN_ENV in env:
        # codex: the URL carries no credential, the env does.
        found.add(env[plan_mcp_wiring.TOKEN_ENV])
    return found


# ── impersonation ───────────────────────────────────────────────────────────


def test_a_pane_token_does_not_authenticate_another_pane() -> None:
    agent_messaging.register("pa", "alpha", "/ws/one")
    agent_messaging.register("pb", "beta", "/ws/one")
    token_a = _codex_spawn_token("pa")
    _codex_spawn_token("pb")
    with pytest.raises(plan_mcp.CallerUnknown, match="token rejected"):
        plan_mcp._resolve_caller(_ctx({"pane": "pb", "t": token_a}))
    # Same refusal when the token rides as a bearer header (codex).
    with pytest.raises(plan_mcp.CallerUnknown, match="token rejected"):
        plan_mcp._resolve_caller(
            _ctx({"pane": "pb"}, {"authorization": f"Bearer {token_a}"})
        )


def test_a_pane_that_was_never_wired_cannot_be_presented_with_any_pane_token() -> None:
    # pb is a live pane, but this backend never spawned it with wiring (no
    # token was ever minted for it): no other pane's token may stand in.
    agent_messaging.register("pa", "alpha", "/ws/one")
    agent_messaging.register("pb", "beta", "/ws/one")
    token_a = _codex_spawn_token("pa")
    with pytest.raises(plan_mcp.CallerUnknown, match="token rejected"):
        plan_mcp._resolve_caller(_ctx({"pane": "pb", "t": token_a}))


def test_the_spawned_pane_is_accepted_with_its_own_token() -> None:
    agent_messaging.register("pa", "alpha", "/ws/one")
    token_a = _codex_spawn_token("pa")
    caller = plan_mcp._resolve_caller(_ctx({"pane": "pa", "t": token_a}))
    assert (caller.kind, caller.pane_id) == ("pane", "pa")
    caller = plan_mcp._resolve_caller(_ctx({"pane": "pa"}, {"authorization": f"Bearer {token_a}"}))
    assert (caller.kind, caller.pane_id) == ("pane", "pa")


def _differ(a: str, b: str) -> None:
    """Fail without echoing either token: test output reaches CI logs."""
    if a == b:
        pytest.fail("two panes were wired with the same token", pytrace=False)


def test_each_pane_gets_its_own_token() -> None:
    _differ(_codex_spawn_token("pa"), _codex_spawn_token("pb"))


def test_a_respawned_pane_keeps_its_token() -> None:
    # Rebuild / resume re-runs spawn wiring under the same pane id; both the
    # CLI that is going away and the one replacing it keep a working token.
    agent_messaging.register("pa", "alpha", "/ws/one")
    first = _codex_spawn_token("pa")
    second = _codex_spawn_token("pa")
    if first != second:
        pytest.fail("a respawn changed the pane's token", pytrace=False)
    assert plan_mcp._resolve_caller(_ctx({"pane": "pa", "t": second})).pane_id == "pa"


def test_an_unknown_token_value_is_refused_for_a_wired_pane() -> None:
    agent_messaging.register("pa", "alpha", "/ws/one")
    _codex_spawn_token("pa")
    with pytest.raises(plan_mcp.CallerUnknown, match="token rejected"):
        plan_mcp._resolve_caller(_ctx({"pane": "pa", "t": "not-" + "the-token"}))
    with pytest.raises(plan_mcp.CallerUnknown, match="token rejected"):
        plan_mcp._resolve_caller(_ctx({"pane": "pa", "t": ""}))


# ── aliases ─────────────────────────────────────────────────────────────────


def test_an_alias_follows_to_the_live_pane_with_the_spawn_token() -> None:
    # A re-attach (detach to a window, reload) gives the pane a new id without
    # re-running spawn wiring: the CLI keeps presenting its spawn id and token.
    token_a = _codex_spawn_token("pa")
    agent_messaging.register("pa-2", "alpha", "/ws/one")
    agent_messaging.add_aliases("pa-2", ["pa"], "/ws/one")
    caller = plan_mcp._resolve_caller(_ctx({"pane": "pa", "t": token_a}))
    assert (caller.kind, caller.pane_id) == ("pane", "pa-2")


def test_the_live_id_of_a_reattached_pane_cannot_be_presented_with_another_token() -> None:
    _codex_spawn_token("pa")
    token_b = _codex_spawn_token("pb")
    agent_messaging.register("pb", "beta", "/ws/one")
    agent_messaging.register("pa-2", "alpha", "/ws/one")
    agent_messaging.add_aliases("pa-2", ["pa"], "/ws/one")
    with pytest.raises(plan_mcp.CallerUnknown, match="token rejected"):
        plan_mcp._resolve_caller(_ctx({"pane": "pa-2", "t": token_b}))
    with pytest.raises(plan_mcp.CallerUnknown, match="token rejected"):
        plan_mcp._resolve_caller(_ctx({"pane": "pa", "t": token_b}))


def test_a_closed_pane_with_its_own_token_still_hears_stale() -> None:
    token_a = _codex_spawn_token("pa")
    agent_messaging.register("pa", "alpha", "/ws/one")
    agent_messaging.unregister("pa")
    with pytest.raises(plan_mcp.CallerUnknown) as err:
        plan_mcp._resolve_caller(_ctx({"pane": "pa", "t": token_a}))
    assert str(err.value) == plan_mcp._STALE


# ── host / external unchanged ───────────────────────────────────────────────


def test_host_and_external_credentials_are_unchanged() -> None:
    assert plan_mcp._resolve_caller(_ctx({"client": "host", "t": plan_mcp_auth.internal_token()})).kind == "host"
    plan_mcp_auth.set_external_enabled(True)
    try:
        caller = plan_mcp._resolve_caller(_ctx({"client": "external", "t": plan_mcp_auth.external_token()}))
        assert caller.kind == "external"
    finally:
        plan_mcp_auth.set_external_enabled(False)
    # A spawn without a pane id still carries the host credential.
    assert plan_mcp_wiring.spawn_token("") == plan_mcp_auth.internal_token()
    assert f"client=host&t={plan_mcp_auth.internal_token()}" in plan_mcp_wiring.plan_mcp_url(PORT)


def test_a_pane_token_is_not_a_host_credential() -> None:
    token_a = _codex_spawn_token("pa")
    with pytest.raises(plan_mcp.CallerUnknown, match="host token rejected"):
        plan_mcp._resolve_caller(_ctx({"client": "host", "t": token_a}))


# ── every vendor mechanism carries the per-pane token ───────────────────────


_WIRED_VENDORS = sorted(
    key for key, spec in registry.VENDORS.items() if spec.mcp_wiring is not None
)


def test_the_vendor_list_covers_every_mechanism() -> None:
    # flag+file (claude, copilot, qwen), flag+env (codex), config env
    # (opencode, kilo), project file (cursor), shim home (kimi, grok,
    # antigravity). A new vendor joins the parametrised test below by itself.
    assert {"claude", "codex", "copilot", "qwen", "opencode", "kilo", "cursor",
            "kimi", "grok", "antigravity"} <= set(_WIRED_VENDORS)


@pytest.mark.parametrize("agent", _WIRED_VENDORS)
def test_every_vendor_spawn_carries_a_token_bound_to_its_own_pane(
    agent: str, home: Path, tmp_path: Path
) -> None:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    agent_messaging.register("pa", "alpha", str(workspace))
    agent_messaging.register("pb", "beta", str(workspace))
    tokens_a = _spawn_tokens(agent, "pa", workspace)
    tokens_b = _spawn_tokens(agent, "pb", workspace)
    assert len(tokens_a) == 1, (agent, len(tokens_a))
    assert len(tokens_b) == 1, (agent, len(tokens_b))
    (token_a,) = tokens_a
    (token_b,) = tokens_b
    _differ(token_a, token_b)
    assert plan_mcp._resolve_caller(_ctx({"pane": "pa", "t": token_a})).pane_id == "pa"
    assert plan_mcp._resolve_caller(_ctx({"pane": "pb", "t": token_b})).pane_id == "pb"
    with pytest.raises(plan_mcp.CallerUnknown, match="token rejected"):
        plan_mcp._resolve_caller(_ctx({"pane": "pb", "t": token_a}))


# ── redaction ───────────────────────────────────────────────────────────────


def test_a_pane_token_is_redacted_from_log_records(caplog: Any) -> None:
    token = _codex_spawn_token("pa")
    log = logging.getLogger("agent_team_backend.test_pane_token")
    record_filter = log_redaction.TokenRedactionFilter()
    log.addFilter(record_filter)
    try:
        with caplog.at_level(logging.INFO, logger="agent_team_backend.test_pane_token"):
            log.info("spawn env %s", {plan_mcp_wiring.TOKEN_ENV: token})
            log.info("bare %s", token)
            log.info("url %s", plan_mcp_wiring.plan_mcp_url(PORT, "pa"))
            log.info(f"inline {token}")
    finally:
        log.removeFilter(record_filter)
    rendered = "\n".join(r.getMessage() for r in caplog.records)
    assert len(caplog.records) == 4
    if token in rendered:
        pytest.fail("a pane token reached a log record", pytrace=False)


# ── redaction: bare tokens wherever a record renders them ───────────────────


def _capture(name: str) -> tuple[logging.Logger, io.StringIO, logging.Handler]:
    """A logger whose own handler formats records the way a log file would."""
    log = logging.getLogger(name)
    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    handler.setFormatter(logging.Formatter("%(message)s"))
    handler.addFilter(log_redaction.TokenRedactionFilter())
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    log.propagate = False
    return log, buf, handler


def _assert_not_in(token: str, text: str) -> None:
    if token in text:
        pytest.fail("a pane token reached the formatted log output", pytrace=False)


def test_a_bare_token_inside_an_exception_arg_is_redacted() -> None:
    token = _codex_spawn_token("pa")
    log, buf, handler = _capture("agent_team_backend.test_pane_token.exc_arg")
    try:
        log.warning("spawn failed: %s", RuntimeError("env " + plan_mcp_wiring.TOKEN_ENV + "=" + token))
    finally:
        log.removeHandler(handler)
    assert "spawn failed" in buf.getvalue()
    _assert_not_in(token, buf.getvalue())


def test_a_bare_token_inside_an_objects_repr_is_redacted() -> None:
    token = _codex_spawn_token("pa")

    class Spawn:
        def __repr__(self) -> str:
            return "Spawn(env={'" + plan_mcp_wiring.TOKEN_ENV + "': '" + token + "'})"

        __str__ = __repr__

    log, buf, handler = _capture("agent_team_backend.test_pane_token.obj_arg")
    try:
        log.info("spawning %s", Spawn())
    finally:
        log.removeHandler(handler)
    assert "spawning Spawn(" in buf.getvalue()
    _assert_not_in(token, buf.getvalue())


def test_a_bare_token_in_a_traceback_is_redacted() -> None:
    token = _codex_spawn_token("pa")
    log, buf, handler = _capture("agent_team_backend.test_pane_token.traceback")
    try:
        try:
            raise ValueError("bad header Bearer " + token)
        except ValueError:
            log.exception("request failed")
        log.info("where", stack_info=True, extra={"marker": token})
    finally:
        log.removeHandler(handler)
    out = buf.getvalue()
    assert "request failed" in out and "Traceback" in out and "ValueError" in out
    _assert_not_in(token, out)


# ── revocation: a token dies with its pane ──────────────────────────────────


class _Terminals:
    """Stands in for app._TERMINALS: which pane ids still have a live PTY."""

    def __init__(self, *pane_ids: str) -> None:
        self.live = set(pane_ids)

    def live_session_ids_for_pane(self, pane_id: str) -> list[str]:
        return [f"t-{pane_id}"] if pane_id in self.live else []


@pytest.fixture
def terminals(monkeypatch: pytest.MonkeyPatch) -> _Terminals:
    from agent_team_backend import app

    fake = _Terminals()
    monkeypatch.setattr(app, "_TERMINALS", fake)
    return fake


def test_a_closed_panes_token_is_revoked_and_a_reused_id_gets_a_fresh_one(terminals: _Terminals) -> None:
    old = _codex_spawn_token("pa")
    agent_messaging.register("pa", "alpha", "/ws/one")
    agent_messaging.unregister("pa")
    assert plan_mcp_wiring.bound_pane_token("pa") == ""
    if old in log_redaction._SECRETS:
        pytest.fail("a revoked token is still kept in the redaction set", pytrace=False)
    # The same id registered again (saved-layout restore): the CLI that held
    # the old token is not accepted as the new pane.
    agent_messaging.register("pa", "alpha-again", "/ws/one")
    with pytest.raises(plan_mcp.CallerUnknown, match="token rejected"):
        plan_mcp._resolve_caller(_ctx({"pane": "pa", "t": old}))
    fresh = _codex_spawn_token("pa")
    _differ(old, fresh)
    assert plan_mcp._resolve_caller(_ctx({"pane": "pa", "t": fresh})).pane_id == "pa"


def test_a_pane_whose_cli_is_still_running_keeps_its_token_when_unregistered(terminals: _Terminals) -> None:
    # Same-id respawn (the embedded AI dock) and a close that reaches the
    # registry before the PTY is gone: the live CLI must not lose MCP.
    token = _codex_spawn_token("pa")
    terminals.live.add("pa")
    agent_messaging.register("pa", "alpha", "/ws/one")
    agent_messaging.unregister("pa")
    if plan_mcp_wiring.bound_pane_token("pa") != token:
        pytest.fail("a pane with a live PTY lost its token", pytrace=False)
    # The PTY then exits: nothing references the id any more.
    terminals.live.discard("pa")
    plan_mcp_wiring.release_pane_token("pa")
    assert plan_mcp_wiring.bound_pane_token("pa") == ""


def test_a_registered_pane_keeps_its_token_when_its_pty_exits(terminals: _Terminals) -> None:
    # The CLI exited but the pane is still on screen: a restart in the same
    # pane id must not strand anything, so only both being gone revokes.
    token = _codex_spawn_token("pa")
    agent_messaging.register("pa", "alpha", "/ws/one")
    plan_mcp_wiring.release_pane_token("pa")
    if plan_mcp_wiring.bound_pane_token("pa") != token:
        pytest.fail("a registered pane lost its token on PTY exit", pytrace=False)


def test_a_reattached_pane_keeps_its_spawn_token_through_unregister_and_purge(
    terminals: _Terminals, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Renderer reload / detach: the window re-keys pa as pa-2 and the old id
    # is unregistered (or ages out offline). The CLI still presents pa.
    token = _codex_spawn_token("pa")
    agent_messaging.register("pa", "alpha", "/ws/one")
    agent_messaging.register("pa-2", "alpha", "/ws/one")
    agent_messaging.add_aliases("pa-2", ["pa"], "/ws/one")
    agent_messaging.unregister("pa")
    assert plan_mcp._resolve_caller(_ctx({"pane": "pa", "t": token})).pane_id == "pa-2"
    owner = object()
    agent_messaging.register("pa-2", "alpha", "/ws/one", owner=owner)
    agent_messaging.drop_owner(owner)
    monkeypatch.setattr(agent_messaging, "OFFLINE_GRACE_S", 0.0)
    agent_messaging.purge_expired()
    # pa-2 aged out with no window coming back: now nothing names pa either.
    assert plan_mcp_wiring.bound_pane_token("pa") == ""


def test_closing_the_live_pane_revokes_its_former_ids_too(terminals: _Terminals) -> None:
    token = _codex_spawn_token("pa")
    agent_messaging.register("pa-2", "alpha", "/ws/one")
    agent_messaging.add_aliases("pa-2", ["pa"], "/ws/one")
    agent_messaging.unregister("pa-2")
    assert plan_mcp_wiring.bound_pane_token("pa") == ""
    with pytest.raises(plan_mcp.CallerUnknown, match="token rejected"):
        plan_mcp._resolve_caller(_ctx({"pane": "pa", "t": token}))


async def test_a_pty_exit_revokes_the_token_of_an_unregistered_pane(terminals: _Terminals) -> None:
    from agent_team_backend import app

    _codex_spawn_token("pa")
    terminals.live.add("pa")
    agent_messaging.register("pa", "alpha", "/ws/one")
    agent_messaging.unregister("pa")
    assert plan_mcp_wiring.bound_pane_token("pa") != ""
    terminals.live.discard("pa")
    await app._active_emit({"type": "terminal.exit", "payload": {"pane_id": "pa", "terminal_session_id": "t-pa"}})
    app._cancel_pane_unregister("pa")
    assert plan_mcp_wiring.bound_pane_token("pa") == ""


def test_a_release_and_a_same_id_respawn_cannot_interleave(
    terminals: _Terminals, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The respawn's wiring must not hand out the token a release has already
    # decided to revoke: it waits, then gets a fresh token that stays bound.
    import threading

    old = _codex_spawn_token("pa")
    entered, proceed = threading.Event(), threading.Event()
    real_check = plan_mcp_wiring._pane_has_live_pty

    def slow_check(pane_id: str) -> bool:
        entered.set()
        proceed.wait(5)
        return real_check(pane_id)

    monkeypatch.setattr(plan_mcp_wiring, "_pane_has_live_pty", slow_check)
    release = threading.Thread(target=plan_mcp_wiring.release_pane_token, args=("pa",))
    release.start()
    assert entered.wait(5)
    handed: list[str] = []
    respawn = threading.Thread(target=lambda: handed.append(plan_mcp_wiring.caller_token("pa")))
    respawn.start()
    respawn.join(0.3)
    blocked = respawn.is_alive()
    proceed.set()
    release.join(5)
    respawn.join(5)
    assert blocked, "the respawn's wiring did not wait for the release"
    assert len(handed) == 1
    if handed[0] == old:
        pytest.fail("the respawn was handed the token being revoked", pytrace=False)
    if plan_mcp_wiring.bound_pane_token("pa") != handed[0]:
        pytest.fail("the respawn's token was revoked under it", pytrace=False)


def test_a_cli_still_running_when_its_id_is_closed_and_reused_keeps_its_token(
    terminals: _Terminals,
) -> None:
    # Documented limit (wiring.release_pane_token): ids are random UUIDs and
    # only the AI dock reuses one, after killing the old PTY. If a CLI is still
    # running when its id is closed and that id registers again, nothing tells
    # the old CLI from the new pane, so the token stays.
    token = _codex_spawn_token("pa")
    terminals.live.add("pa")
    agent_messaging.register("pa", "alpha", "/ws/one")
    agent_messaging.unregister("pa")
    agent_messaging.register("pa", "alpha-again", "/ws/one")
    terminals.live.discard("pa")
    plan_mcp_wiring.release_pane_token("pa")
    if plan_mcp_wiring.bound_pane_token("pa") != token:
        pytest.fail("expected the documented limit to hold", pytrace=False)
