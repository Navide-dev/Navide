"""Editable Guard grading: built-in rule levels, custom rule levels and the
protected-branch list. Loosening needs the main process's confirmation;
tightening does not; the safety floor and the policy matrix stay fixed."""

from __future__ import annotations

import hashlib
import hmac
import time
import uuid
from typing import Any

import pytest

from agent_team_backend import app, confirm_token
from agent_team_backend.db import Database
from agent_team_backend.guard import evaluate, mark_tainted, policy, terminal_policy, ws_api
from agent_team_backend.guard.builtin_rules import BUILTIN_RULES, FLOOR_RULES
from agent_team_backend.guard.store import COMPONENT, GuardStore, _v1, _v2, _v3

pytestmark = pytest.mark.asyncio

_KEY = "test-confirmation-key"
HOME = "/Users/tester"
WS = "/Users/tester/proj"


@pytest.fixture(autouse=True)
def _confirmable(monkeypatch):
    confirm_token._reset_for_test(_KEY)
    monkeypatch.setenv("HOME", HOME)
    monkeypatch.setenv("USERPROFILE", HOME)
    yield
    confirm_token._reset_for_test()


def _confirmation(action: str, subject: str) -> dict[str, str]:
    nonce = uuid.uuid4().hex
    expires = str(time.time() + 30)
    payload = "\x00".join(("navide/trust-confirm/v2", nonce, expires, action, "", subject))
    return {"nonce": nonce, "expires": expires,
            "mac": hmac.new(_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()}


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


async def raw(msg_type: str, payload: dict | None = None) -> dict[str, Any]:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    await app.handle_message(session, {"id": "r1", "type": msg_type, "payload": payload or {}})
    return session.websocket.sent[-1]  # type: ignore[attr-defined]


def _refused(frame: dict) -> bool:
    return frame["ok"] is False and frame["error"]["code"] == "CONFIRMATION_REQUIRED"


def run(command: str, *, source: str = "local", pane: str = "p1"):
    return evaluate(pane_id=pane, vendor="claude", tool="Bash", tool_input={"command": command},
                    cwd=WS, workspace=WS, source=source)


async def set_level(rule_id: str, level: str, *, confirm: bool = False) -> dict:
    payload: dict[str, Any] = {"id": rule_id, "level": level}
    if confirm:
        payload["confirm"] = _confirmation("guard.builtin.set_level", f"{rule_id}:{level}")
    return await raw("guard.builtin.set_level", payload)


# ── table ──────────────────────────────────────────────────────────────────
async def test_get_lists_every_builtin_rule_and_the_default_branches():
    res = (await raw("guard.builtin.get"))["payload"]
    assert [r["id"] for r in res["rules"]] == [r.id for r in BUILTIN_RULES]
    by_id = {r["id"]: r for r in res["rules"]}
    assert by_id["git-push"]["default_level"] == "high" and by_id["git-push"]["level"] == "high"
    assert by_id["eval"]["default_level"] == "normal"
    assert all(by_id[r]["floor"] for r in FLOOR_RULES)
    assert res["protected_branches"] == ["main", "master"]


async def test_every_rule_id_classify_can_report_is_in_the_table():
    import importlib
    import re
    from pathlib import Path

    src = Path(importlib.import_module("agent_team_backend.guard.classify").__file__).read_text(encoding="utf-8")
    emitted = set(re.findall(r'(?:hit\("[a-z]+", |opaque\()"([a-z-]+)"', src))
    assert emitted and emitted == {r.id for r in BUILTIN_RULES}


# ── loosening needs the confirmation ───────────────────────────────────────
async def test_loosening_a_rule_without_a_token_is_refused(guard_store):
    assert _refused(await set_level("git-push", "normal"))
    assert guard_store.rule_overrides() == {}
    assert run("git push").level == "high"
    frame = await set_level("git-push", "normal", confirm=True)
    assert frame["ok"] and frame["payload"]["ok"]
    assert run("git push").level == "normal"


async def test_tightening_needs_no_token_but_undoing_it_does(guard_store):
    frame = await set_level("git-push", "critical")
    assert frame["payload"]["ok"] and guard_store.rule_overrides() == {"git-push": "critical"}
    assert (run("git push").level, run("git push").action) == ("critical", "ask")
    # Back to its default is still a loosening from where it stands now.
    assert _refused(await set_level("git-push", "high"))
    assert (await set_level("git-push", "high", confirm=True))["payload"]["ok"]
    assert guard_store.rule_overrides() == {}


async def test_raising_an_unanalyzable_rule_grades_it():
    assert (await set_level("eval", "high"))["payload"]["ok"]
    assert run('eval "$X"').level == "high"


async def test_a_token_for_one_change_cannot_sign_another():
    payload = {"id": "git-push", "level": "normal",
               "confirm": _confirmation("guard.builtin.set_level", "git-reset-hard:normal")}
    assert _refused(await raw("guard.builtin.set_level", payload))


# ── the fixed floor ────────────────────────────────────────────────────────
@pytest.mark.parametrize("rule_id", sorted(FLOOR_RULES))
async def test_floor_rules_cannot_go_below_high(guard_store, rule_id):
    frame = await set_level(rule_id, "normal", confirm=True)
    assert frame["payload"]["ok"] is False
    with pytest.raises(ValueError):
        guard_store.set_rule_level(rule_id, "normal")
    assert (await set_level(rule_id, "high", confirm=True))["payload"]["ok"]


async def test_a_floor_row_written_behind_the_store_is_still_clamped(guard_store):
    with guard_store._db.transaction() as cur:
        cur.execute("INSERT INTO guard_rule_overrides (id, level) VALUES ('credential-access', 'normal')")
    guard_store._grading_cache = None
    assert run("cat ~/.ssh/id_rsa").level == "high"


async def test_relay_and_taint_rows_ignore_overrides(guard_store):
    assert (await set_level("credential-access", "high", confirm=True))["payload"]["ok"]
    cmd = "cat ~/.ssh/id_rsa"
    assert (run(cmd).level, run(cmd).action) == ("high", "allow")
    # Chat approval of a high action still needs someone at the computer.
    assert run(cmd, source="relay").action == "deny"
    # A pane that received external content still asks.
    mark_tainted("p9", "agent")
    assert run(cmd, pane="p9").action == "ask"
    # An unanalyzable command on a tainted pane stays high whatever its rule says.
    assert run('eval "$X"', pane="p9").level == "high"
    # The switch never turns the relay row off.
    guard_store.set_enabled(False)
    assert run(cmd, source="relay").action == "deny"


async def test_an_allow_never_exempts_critical_even_after_tightening(guard_store):
    guard_store.set_rule_level("git-push", "critical")
    guard_store.rules_add("allow", "git push*")
    assert run("git push origin feature").level == "critical"


# ── custom rules ───────────────────────────────────────────────────────────
async def test_custom_deny_can_be_high(guard_store):
    frame = await raw("guard.rules.add", {"kind": "deny", "pattern": "docker system prune", "level": "high"})
    assert frame["payload"]["ok"] and frame["payload"]["rules"][0]["level"] == "high"
    d = run("docker system prune -af")
    assert (d.level, d.action) == ("high", "allow")
    assert run("docker system prune -af", source="relay").action == "deny"
    assert (await raw("guard.rules.add", {"kind": "deny", "pattern": "x", "level": "normal"}))["payload"]["ok"] is False


async def test_adding_an_allow_needs_a_token(guard_store):
    assert _refused(await raw("guard.rules.add", {"kind": "allow", "pattern": "git push"}))
    assert guard_store.rules_list() == []
    frame = await raw("guard.rules.add", {"kind": "allow", "pattern": "git push",
                                          "confirm": _confirmation("guard.rules.add", "allow:git push")})
    assert frame["payload"]["ok"] and frame["payload"]["rules"][0]["level"] == "normal"


async def test_removing_a_deny_needs_a_token_removing_an_allow_does_not(guard_store):
    deny = guard_store.rules_add("deny", "docker system prune")
    allow = guard_store.rules_add("allow", "git push")
    assert _refused(await raw("guard.rules.remove", {"id": deny}))
    assert (await raw("guard.rules.remove", {"id": allow}))["payload"]["ok"]
    frame = await raw("guard.rules.remove", {"id": deny, "confirm": _confirmation("guard.rules.remove", str(deny))})
    assert frame["payload"]["rules"] == []


# ── protected branches: one list for Guard and terminal protection ────────
async def test_adding_a_branch_protects_it_in_guard_and_in_terminals(guard_store):
    assert run("git push --force origin release").level == "high"
    frame = await raw("guard.branches.add", {"name": "release"})
    assert frame["payload"]["protected_branches"] == ["main", "master", "release"]
    d = run("git push --force origin release")
    assert d.level == "critical" and "git-force-push-protected" in d.rule_ids
    refusal = terminal_policy.check_with_store("git push --force origin release", workspace=WS)
    assert refusal is not None and refusal.rule == "force-push-main"


async def test_removing_a_branch_needs_a_token_and_unprotects_it_in_both(guard_store):
    assert terminal_policy.check_with_store("git push -f origin main", workspace=WS) is not None
    assert _refused(await raw("guard.branches.remove", {"name": "main"}))
    assert "main" in guard_store.protected_branches()
    frame = await raw("guard.branches.remove", {"name": "main",
                                                "confirm": _confirmation("guard.branches.remove", "main")})
    assert frame["payload"]["protected_branches"] == ["master"]
    assert run("git push -f origin main").level == "high"
    # classifier-high is off by default in terminal protection.
    assert terminal_policy.check_with_store("git push -f origin main", workspace=WS) is None


async def test_branch_names_are_validated():
    for bad in ("", "a b", "../x", "-f", "x/"):
        assert (await raw("guard.branches.add", {"name": bad}))["payload"]["ok"] is False


# ── test box ───────────────────────────────────────────────────────────────
async def test_the_test_box_shows_each_rule_and_its_grading(guard_store):
    guard_store.set_rule_level("git-push", "critical")
    rid = guard_store.rules_add("deny", "origin", level="high")
    res = (await raw("guard.test", {"command": "git push origin", "source": "local"}))["payload"]
    matched = {m["id"]: m for m in res["matched"]}
    assert matched["git-push"]["default_level"] == "high" and matched["git-push"]["level"] == "critical"
    assert matched[f"user-deny:{rid}"]["level"] == "high"
    assert res["graded_level"] == "critical"
    assert res["decision"] == {"action": "ask", "level": "critical",
                               "rule_ids": ["git-push", f"user-deny:{rid}"], "tainted": False}


async def test_the_test_box_applies_a_glob_allow_to_a_taint_raise(guard_store):
    # Mirrors engine._evaluate (issue #192).
    guard_store.rules_add("allow", "python3")
    payload = {"command": "python3 -c 'print(1)'", "source": "local", "tainted": True}
    assert (await raw("guard.test", payload))["payload"]["decision"]["action"] == "ask"
    rid = guard_store.rules_add("allow", "python3 -c *")
    res = (await raw("guard.test", payload))["payload"]
    assert res["decision"]["action"] == "allow" and f"user-allow:{rid}" in res["decision"]["rule_ids"]
    relay = (await raw("guard.test", {**payload, "source": "relay"}))["payload"]
    assert relay["decision"]["action"] == "deny"


# ── migration ──────────────────────────────────────────────────────────────
async def test_v3_to_v4_keeps_legacy_deny_rows_critical(tmp_path):
    db = Database(tmp_path / "old.db")
    db.migrate(COMPONENT, 1, _v1)
    db.migrate(COMPONENT, 2, _v2)
    db.migrate(COMPONENT, 3, _v3)
    with db.transaction() as cur:
        cur.execute("INSERT INTO guard_rules (kind, pattern, note, created) VALUES ('deny', 'docker', '', 0)")
        cur.execute("INSERT INTO guard_rules (kind, pattern, note, created) VALUES ('allow', 'git push', '', 0)")
    store = GuardStore(db)
    assert db.schema_version(COMPONENT) == 4
    assert [(r["kind"], r["level"]) for r in store.rules_list()] == [("deny", "critical"), ("allow", "normal")]
    assert store.protected_branches() == frozenset({"main", "master"})
    assert store.rule_overrides() == {}
    level, _ = policy.apply_user_rules("normal", (), "docker ps", store.rules_list())
    assert level == "critical"


async def test_every_new_request_type_is_registered():
    from agent_team_backend import ws_handlers

    for t in ("guard.builtin.get", "guard.builtin.set_level", "guard.branches.add", "guard.branches.remove"):
        assert t in ws_api.MESSAGE_TYPES and ws_handlers.lookup(t) is ws_api.handle
