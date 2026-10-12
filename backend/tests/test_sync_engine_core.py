"""Sync engine core: paging, cursors, origins, refusals and per-scope results.

Driven against the same ``FakeServer`` as ``test_sync_engine`` — which answers
like Navide-Server — because every bug here was a disagreement between what
the engine assumed the server said and what it actually says.
"""

from __future__ import annotations

import pytest

from agent_team_backend import sync_engine

from .test_sync_engine import Device, FakeServer, account_key  # noqa: F401 - a fixture


# ── X-0: paging ──────────────────────────────────────────────────────────────
async def test_a_pull_reads_every_page_not_just_the_first(tmp_path, account_key, monkeypatch):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {f"p{i}": {"n": i} for i in range(5)})
    await a.sync()
    monkeypatch.setattr(sync_engine, "PULL_PAGE", 2)
    b = Device(tmp_path, server, "dev-b")
    await b.sync()
    assert b.adapter.items == a.adapter.items


# ── X-1: a push reply must not move the cursor past someone else's write ─────
async def test_a_write_landing_between_pull_and_push_is_not_skipped(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a")
    b = Device(tmp_path, server, "dev-b", {"mine": {"v": "b"}})
    forward = b.engine._request
    interleaved = False

    async def request(msg_type, payload):
        nonlocal interleaved
        if msg_type == "sync.push" and not interleaved:
            # Another device writes after B pulled and before B pushes.
            interleaved = True
            a.adapter.items["theirs"] = {"v": "a"}
            await a.sync()
        return await forward(msg_type, payload)

    b.engine._request = request
    await b.sync()
    await b.sync()
    assert b.adapter.items.get("theirs") == {"v": "a"}


# ── X-2 / SEC-12 / SEC-1: who wrote a record ─────────────────────────────────
def test_the_pinned_signing_key_is_read_from_the_field_pins_store(monkeypatch):
    from agent_team_backend import trust_store

    monkeypatch.setattr(trust_store, "pin_for", lambda _d: {"signKey": "KEY", "memberId": "m"})
    assert sync_engine._pinned_signing_key("dev-x") == "KEY"


def _forged(server: FakeServer, item_id: str, *, device: str, deleted: bool, body: str = "") -> int:
    rev = server.cursors.get("prompts", 0) + 1
    server.cursors["prompts"] = rev
    server.rows[("prompts", item_id)] = {
        "itemId": item_id, "rev": rev, "updatedAt": "2030-01-01T00:00:00+00:00",
        "deviceId": device, "deleted": 1 if deleted else 0,
        "body": body or None, "sig": "forged",
    }
    return rev


async def test_a_forged_record_from_a_pinned_device_is_dropped(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}})
    await b.sync()
    _forged(server, "x", device="dev-a", deleted=True)
    await b.sync()
    assert b.adapter.items == {"x": {"v": 1}}
    assert not b.store.state("prompts", "x").deleted


async def test_a_record_claiming_to_be_ours_must_carry_our_signature(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}})
    await b.sync()
    before = b.store.state("prompts", "x")
    _forged(server, "x", device="dev-b", deleted=True)
    await b.sync()
    assert b.store.state("prompts", "x") == before
    assert b.adapter.items == {"x": {"v": 1}}


async def test_a_tombstone_from_an_unknown_device_asks_instead_of_deleting(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}})
    b.engine._signing_key_for = lambda d: "" if d == "dev-stranger" else b.own_key
    await b.sync()
    _forged(server, "x", device="dev-stranger", deleted=True)
    await b.sync()
    assert b.adapter.items == {"x": {"v": 1}}
    assert [c["itemId"] for c in b.store.conflicts("prompts")] == ["x"]


async def test_a_live_record_from_an_unknown_device_is_still_taken(tmp_path, account_key):
    # Its body opened under the account key, which only the account's own
    # devices hold: that is the proof of origin a missing pin cannot give.
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"x": {"v": 1}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")
    b.engine._signing_key_for = lambda _d: ""
    await b.sync()
    assert b.adapter.items == {"x": {"v": 1}}


async def test_a_record_from_a_blocked_device_is_refused(tmp_path, account_key):
    """A blocked device of this account still holds the account key, so its
    records open — and with the pin ignored, or with none, they read as
    "unknown origin" and were taken. A stolen machine is the case a block is
    for; what it writes into sync must not land here."""
    from agent_team_backend import trust_store

    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"x": {"v": 1}})
    await a.sync()
    trust_store.load()
    trust_store.note_blocked("dev-a", "")
    b = Device(tmp_path, server, "dev-b")
    b.engine._signing_key_for = lambda _d: ""
    await b.sync()
    assert b.adapter.items == {}


async def test_a_tombstone_from_a_blocked_device_deletes_nothing(tmp_path, account_key):
    from agent_team_backend import trust_store

    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}})
    await b.sync()
    trust_store.load()
    trust_store.note_blocked("dev-stolen", "")
    b.engine._signing_key_for = lambda _d: ""
    _forged(server, "x", device="dev-stolen", deleted=True)
    await b.sync()
    assert b.adapter.items == {"x": {"v": 1}}
    assert b.store.conflicts("prompts") == []


async def test_a_tombstone_from_an_unknown_device_for_an_item_we_lack_is_taken(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b")
    b.engine._signing_key_for = lambda _d: ""
    _forged(server, "gone", device="dev-stranger", deleted=True)
    await b.sync()
    assert b.store.conflicts("prompts") == []


# ── C-1 / S-4 / M-3: an adapter that refuses a record ────────────────────────
class _Refusing:
    """Wraps a device's adapter so its ``apply`` refuses chosen items."""

    def __init__(self, device: Device, refuse: set[str], *, raises: bool = False) -> None:
        self.inner = device.adapter.apply
        self.refuse = refuse
        self.raises = raises
        device.adapter.apply = self.apply

    def apply(self, item_id, payload):
        if item_id in self.refuse:
            if self.raises:
                raise ValueError("not here")
            return False
        return self.inner(item_id, payload)


@pytest.mark.parametrize("raises", [False, True])
async def test_a_refused_new_item_is_never_turned_into_a_delete(tmp_path, account_key, raises):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"y": {"v": 1}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")
    _Refusing(b, {"y"}, raises=raises)
    await b.sync()
    await b.sync()
    assert not server.rows[("prompts", "y")]["deleted"]
    assert b.store.state("prompts", "y") is None


async def test_a_refused_update_does_not_push_the_old_copy_back(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"x": {"v": 1}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")
    await b.sync()
    a.adapter.items["x"] = {"v": 2}
    await a.sync()
    _Refusing(b, {"x"})
    await b.sync()
    await b.sync()
    await a.sync()
    assert a.adapter.items == {"x": {"v": 2}}
    assert b.adapter.items == {"x": {"v": 1}}


async def test_keeping_a_remote_copy_the_adapter_refuses_keeps_the_conflict(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"x": {"v": 1}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")
    await b.sync()
    a.adapter.items["x"] = {"v": 2}
    b.adapter.items["x"] = {"v": 3}
    await a.sync()
    await b.sync()
    assert b.store.conflict_ids("prompts") == {"x"}
    _Refusing(b, {"x"})
    with pytest.raises(sync_engine.SyncError):
        b.engine.resolve("prompts", "x", sync_engine.KEEP_REMOTE)
    assert b.store.conflict_ids("prompts") == {"x"}


# ── X-5: what a round reports ────────────────────────────────────────────────
RESULT_KEYS = {"scope", "ok", "pulled", "pushed", "conflicts", "held", "refused", "tooLarge", "at"}


async def test_a_round_reports_its_outcome_and_tells_the_listener(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"y": {"v": 1}, "z": {"v": 2}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b", {"mine": {"v": 3}})
    heard = []
    b.engine._on_result = heard.append
    _Refusing(b, {"y"})
    result = await b.sync()
    assert RESULT_KEYS <= set(result)
    assert result["ok"] is True
    assert result["pulled"] == 1 and result["pushed"] == 1
    assert result["refused"] == ["y"] and result["held"] == [] and result["tooLarge"] == []
    assert heard == [result]
    assert b.engine.last_results()["prompts"] == result


async def test_a_failing_scope_is_reported_and_the_others_still_run(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}})
    from .test_sync_engine import DictScope

    broken = DictScope("mcp", {"m": {"v": 1}})

    def snapshot():
        raise RuntimeError("disk on fire")

    broken.snapshot = snapshot
    b.engine.register(broken)
    results = {r["scope"]: r for r in await b.engine.sync_all()}
    assert results["mcp"]["ok"] is False and "RuntimeError" in results["mcp"]["error"]
    assert results["prompts"]["ok"] is True and results["prompts"]["pushed"] == 1
    assert b.engine.last_results()["mcp"]["ok"] is False


async def test_a_skipped_scope_says_why(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b")
    b.engine._enabled = lambda _s: False
    result = await b.sync()
    assert result["ok"] is True and result["skipped"] == "disabled"


async def test_an_item_the_adapter_calls_oversized_is_reported_and_never_sent(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"big": {"v": 1}, "small": {"v": 2}})
    b.adapter.oversized = lambda: ["big"]
    result = await b.sync()
    assert result["tooLarge"] == ["big"]
    assert ("prompts", "big") not in server.rows
    b.adapter.items.pop("small")
    await b.sync()
    assert ("prompts", "big") not in server.rows


async def test_an_oversized_item_the_adapter_left_out_of_its_snapshot_is_not_deleted(
    tmp_path, account_key
):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"grew": {"v": 1}})
    await b.sync()
    # It grew past the limit here: the adapter lists it as oversized and no
    # longer offers it. That is not a local delete.
    b.adapter.items.pop("grew")
    b.adapter.oversized = lambda: ["grew"]
    result = await b.sync()
    assert result["tooLarge"] == ["grew"]
    assert not server.rows[("prompts", "grew")]["deleted"]


async def test_items_the_adapter_gave_up_on_are_held_and_given_up_not_refused(
    tmp_path, account_key
):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"y": {"v": 1}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")
    _Refusing(b, {"y"})  # the adapter's own give-up answers False
    b.adapter.failed = lambda: ["y"]
    result = await b.sync()
    assert result["refused"] == []
    assert result["held"] == ["y"] and result["gaveUp"] == ["y"]


async def test_a_record_over_the_size_limit_is_reported_too_large(tmp_path, account_key, monkeypatch):
    monkeypatch.setattr(sync_engine, "MAX_BODY_BYTES", 200)
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"big": {"v": "x" * 400}})
    result = await b.sync()
    assert result["tooLarge"] == ["big"] and result["pushed"] == 0


async def test_a_deferred_item_is_reported_held(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"y": {"v": 1}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")

    def defer(item_id, payload):
        raise sync_engine.DeferItem(item_id)

    b.adapter.apply = defer
    result = await b.sync()
    assert result["held"] == ["y"]


# ── ACC: account scope ───────────────────────────────────────────────────────
async def test_a_server_cursor_behind_ours_is_a_reset_and_everything_is_read_again(
    tmp_path, account_key
):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"x": {"v": 1}, "y": {"v": 2}, "z": {"v": 3}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")
    await b.sync()
    assert b.store.cursor("prompts") == 3
    # A different account (or a reset server) behind the same link: rev 1.
    fresh = FakeServer()
    c = Device(tmp_path, fresh, "dev-c", {"w": {"v": 9}})
    await c.sync()
    b.engine._request = _as_device("dev-b", fresh)
    await b.sync()
    assert b.adapter.items["w"] == {"v": 9}
    # B's own items went up to the new server as new ones, not as edits of
    # revs that server never issued.
    assert {i for (_s, i) in fresh.rows} == {"w", "x", "y", "z"}


def _as_device(name: str, server: FakeServer):
    async def request(msg_type, payload):
        if msg_type == "sync.push":
            for item in payload["items"]:
                item["deviceId"] = name
        return await server.request(msg_type, payload)

    return request


async def _rev0_conflict(tmp_path) -> tuple[FakeServer, Device]:
    """B edits an item whose cloud row has vanished: the server answers rev 0."""
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"other": {"v": 0}})
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}})
    await b.sync()
    await a.sync()  # keeps the server's cursor ahead, so this is no reset
    del server.rows[("prompts", "x")]
    b.adapter.items["x"] = {"v": 2}
    await b.sync()
    return server, b


async def test_a_conflict_with_a_row_the_cloud_never_had_says_so(tmp_path, account_key):
    _server, b = await _rev0_conflict(tmp_path)
    [row] = b.store.conflicts("prompts")
    assert row["itemId"] == "x" and row["remoteAbsent"] is True


async def test_keeping_the_cloud_copy_of_nothing_never_deletes_the_local_item(tmp_path, account_key):
    _server, b = await _rev0_conflict(tmp_path)
    with pytest.raises(sync_engine.SyncError):
        b.engine.resolve("prompts", "x", sync_engine.KEEP_REMOTE)
    assert b.adapter.items["x"] == {"v": 2}
    assert b.store.conflict_ids("prompts") == {"x"}


async def test_keeping_the_local_copy_of_a_vanished_row_puts_it_back(tmp_path, account_key):
    server, b = await _rev0_conflict(tmp_path)
    b.engine.resolve("prompts", "x", sync_engine.KEEP_LOCAL)
    await b.sync()
    assert not server.rows[("prompts", "x")]["deleted"]


async def test_keeping_an_unchanged_local_copy_pushes_it_again(tmp_path, account_key):
    # The unproven tombstone case: B never edited x, so its copy still equals
    # what was agreed — and "keep mine" must still re-create it in the cloud.
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}})
    b.engine._signing_key_for = lambda d: "" if d == "dev-stranger" else b.own_key
    await b.sync()
    _forged(server, "x", device="dev-stranger", deleted=True)
    await b.sync()
    b.engine.resolve("prompts", "x", sync_engine.KEEP_LOCAL)
    await b.sync()
    assert not server.rows[("prompts", "x")]["deleted"]


# ── X-3: a pull page must fit in one WebSocket frame ─────────────────────────
class FramedServer(FakeServer):
    """A server that, like the real link, cannot deliver a reply over 1 MiB:
    the client's websocket closes with 1009 and the request never answers."""

    MAX_FRAME = 1024 * 1024

    def _pull(self, payload: dict) -> dict:
        import json

        reply = super()._pull(payload)
        if len(json.dumps({"ok": True, "payload": reply})) > self.MAX_FRAME:
            raise ConnectionError("1009 message too big")
        return reply


def _big(n: int) -> dict:
    return {"text": "x" * n}


async def test_a_scope_of_large_records_is_pulled_in_pages_that_fit_a_frame(tmp_path, account_key):
    from .test_sync_engine import DictScope

    server = FramedServer()
    a = Device(tmp_path, server, "dev-a")
    a.engine.register(DictScope("memory", {f"m{i}": _big(250 * 1024) for i in range(4)}))
    await a.engine.sync("memory")
    b = Device(tmp_path, server, "dev-b")
    mine = DictScope("memory")
    b.engine.register(mine)
    result = await b.engine.sync("memory")
    assert result["pulled"] == 4 and len(mine.items) == 4


async def test_large_rows_seen_once_shrink_the_next_pages(tmp_path, account_key):
    server = FramedServer()
    b = Device(tmp_path, server, "dev-b")
    assert b.engine._pull_limit("prompts") > 1
    b.engine._learn_rows("prompts", [{"body": "x" * (400 * 1024)}])
    assert b.engine._pull_limit("prompts") == 1


async def test_a_conflict_the_server_deferred_is_pushed_again(tmp_path, account_key):
    # Navide-Server answers a conflict it has no room for in the frame as a
    # rejection (CONFLICT_DEFERRED): it must not be recorded as synced.
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}})
    forward = b.engine._request
    deferred = True

    async def request(msg_type, payload):
        nonlocal deferred
        if msg_type == "sync.push" and deferred:
            deferred = False
            return {"ok": True, "payload": {
                "scope": "prompts", "cursor": 0, "accepted": [], "conflicts": [],
                "rejected": [{"itemId": "x", "code": "CONFLICT_DEFERRED", "rev": 0}],
            }}
        return await forward(msg_type, payload)

    b.engine._request = request
    first = await b.sync()
    assert first["pushed"] == 0 and b.store.state("prompts", "x") is None
    await b.sync()
    assert ("prompts", "x") in server.rows


async def test_an_explicit_pull_the_adapter_refuses_says_refused(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"y": {"v": 1}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")
    _Refusing(b, {"y"})
    assert await b.engine.pull_items("prompts", ["y"]) == [{"itemId": "y", "result": "refused"}]
    assert b.store.state("prompts", "y") is None


# ── S-6: one item that cannot land must not hold the scope ───────────────────
class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class _Stuck:
    """An adapter apply that defers chosen items until told otherwise."""

    def __init__(self, device: Device, stuck: set[str]) -> None:
        self.inner = device.adapter.apply
        self.stuck = set(stuck)
        self.calls: list[str] = []
        device.adapter.apply = self.apply

    def apply(self, item_id, payload):
        self.calls.append(item_id)
        if item_id in self.stuck:
            raise sync_engine.DeferItem(item_id)
        return self.inner(item_id, payload)


async def _stuck_pair(tmp_path):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"stuck": {"v": 1}})
    await a.sync()
    a.adapter.items["after"] = {"v": 2}
    await a.sync()
    b = Device(tmp_path, server, "dev-b")
    clock = _Clock()
    b.engine._clock = clock
    return server, a, b, clock


async def test_a_deferred_item_does_not_stop_the_rows_behind_it(tmp_path, account_key):
    _server, _a, b, _clock = await _stuck_pair(tmp_path)
    _Stuck(b, {"stuck"})
    result = await b.sync()
    assert b.adapter.items == {"after": {"v": 2}}
    assert result["held"] == ["stuck"]
    # The read position stays short of it, so a restart still retries it.
    assert b.store.cursor("prompts") == 0


async def test_a_deferred_item_is_retried_with_backoff_not_every_round(tmp_path, account_key):
    _server, _a, b, clock = await _stuck_pair(tmp_path)
    stuck = _Stuck(b, {"stuck"})
    await b.sync()
    await b.sync()  # the first deferral is retried at once
    assert stuck.calls.count("stuck") == 2
    await b.sync()  # the second one waits
    assert stuck.calls.count("stuck") == 2
    clock.now += 3600
    await b.sync()
    assert stuck.calls.count("stuck") == 3


async def test_an_item_deferred_too_often_is_marked_given_up_and_still_retried(tmp_path, account_key):
    _server, _a, b, clock = await _stuck_pair(tmp_path)
    stuck = _Stuck(b, {"stuck"})
    result = None
    for _ in range(sync_engine.DEFER_GIVE_UP_ATTEMPTS):
        result = await b.sync()
        clock.now += 3600
    assert result["gaveUp"] == ["stuck"] and "stuck" in result["held"]
    stuck.stuck.clear()
    result = await b.sync()
    assert b.adapter.items["stuck"] == {"v": 1}
    assert result["held"] == [] and result["gaveUp"] == []
    assert b.store.cursor("prompts") == 2


async def test_a_held_item_survives_a_restart(tmp_path, account_key):
    server, _a, b, _clock = await _stuck_pair(tmp_path)
    _Stuck(b, {"stuck"})
    await b.sync()
    restarted = Device(tmp_path, server, "dev-b")  # same db file, fresh engine
    restarted.adapter.items = dict(b.adapter.items)
    await restarted.sync()
    assert restarted.adapter.items["stuck"] == {"v": 1}


# ── security review (sync審-資安) ────────────────────────────────────────────
async def test_a_refusal_is_logged_without_what_the_adapter_said(tmp_path, account_key, caplog):
    # D7: an adapter's exception text can quote the payload it refused.
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"y": {"secret": "hunter2"}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")

    def apply(item_id, payload):
        raise ValueError(f"cannot take {payload}")

    b.adapter.apply = apply
    with caplog.at_level("WARNING"):
        await b.sync()
    assert "hunter2" not in caplog.text
    assert "ValueError" in caplog.text


async def test_a_pull_round_stops_after_a_bounded_number_of_pages(tmp_path, account_key, monkeypatch):
    # A4: a server that always says "more" with fresh revs.
    monkeypatch.setattr(sync_engine, "MAX_PULL_PAGES", 7)
    b = Device(tmp_path, FakeServer(), "dev-b")
    calls = 0

    async def request(msg_type, payload):
        nonlocal calls
        if msg_type != "sync.pull":
            return {"ok": True, "payload": {"accepted": [], "conflicts": [], "cursor": 0}}
        calls += 1
        since = int(payload.get("since") or 0)
        row = {"itemId": f"junk{since}", "rev": since + 1, "updatedAt": "x", "deviceId": "dev-z",
               "deleted": 1, "body": None, "sig": None}
        return {"ok": True, "payload": {"scope": "prompts", "cursor": since + 1, "items": [row], "more": True}}

    b.engine._request = request
    await b.sync()
    assert calls == 7


async def test_a_reset_keeps_a_local_delete_that_was_waiting_to_go_up(tmp_path, account_key):
    # A3: x was deleted here and the round that would carry it up met a reset.
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}, "y": {"v": 1}})
    await b.sync()
    b.adapter.items.pop("x")
    forward = b.engine._request
    lied = False

    async def request(msg_type, payload):
        nonlocal lied
        reply = await forward(msg_type, payload)
        if msg_type == "sync.pull" and not lied and int(payload.get("since") or 0) > 0:
            lied = True
            reply["payload"] = dict(reply["payload"], cursor=0, items=[], more=False)
        return reply

    b.engine._request = request
    await b.sync()
    await b.sync()
    assert "x" not in b.adapter.items
    assert server.rows[("prompts", "x")]["deleted"] == 1


async def test_a_pin_for_another_account_is_not_a_pin(tmp_path, account_key, monkeypatch):
    # A2: a device pinned under a different member does not vouch for this account.
    from agent_team_backend import trust_store

    monkeypatch.setattr(trust_store, "pin_for", lambda _d: {"signKey": "KEY", "memberId": "m-other"})
    assert sync_engine._pinned_signing_key("dev-x", "m-me") == ""
    monkeypatch.setattr(trust_store, "pin_for", lambda _d: {"signKey": "KEY", "memberId": "m-me"})
    assert sync_engine._pinned_signing_key("dev-x", "m-me") == "KEY"


def test_the_engine_checks_pins_against_the_signed_in_member(tmp_path, monkeypatch):
    from agent_team_backend import trust_store
    from agent_team_backend.db import Database

    monkeypatch.setattr(trust_store, "pin_for", lambda _d: {"signKey": "KEY", "memberId": "m-other"})
    engine = sync_engine.SyncEngine(
        sync_engine.SyncStore(Database(tmp_path / "e.db")),
        lambda *_a: None,
        device_id=lambda: "me",
        enabled=lambda _s: True,
        account_member=lambda: "m-me",
    )
    assert engine._signing_key_for("dev-x") == ""


# ── records from releases that did not sign (≤ 0.2.3) ───────────────────────
def _unsigned(server: FakeServer, item_id: str, payload, *, device: str, deleted: bool = False) -> None:
    import json

    from agent_team_backend import sync_keyring

    rev = server.cursors.get("prompts", 0) + 1
    server.cursors["prompts"] = rev
    body = None if deleted else sync_keyring.encrypt(
        json.dumps(payload, sort_keys=True, separators=(",", ":")), scope="prompts", item_id=item_id
    )
    server.rows[("prompts", item_id)] = {
        "itemId": item_id, "rev": rev, "updatedAt": "t", "deviceId": device,
        "deleted": 1 if deleted else 0, "body": body, "sig": "",
    }


async def test_an_unsigned_record_from_a_pinned_device_is_taken(tmp_path, account_key):
    server = FakeServer()
    _unsigned(server, "p1", {"v": 1}, device="old-dev")
    b = Device(tmp_path, server, "dev-b")  # pins every device, old-dev included
    await b.sync()
    assert b.adapter.items == {"p1": {"v": 1}}


async def test_an_unsigned_tombstone_over_an_item_held_here_asks(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}})
    await b.sync()
    _unsigned(server, "x", None, device="old-dev", deleted=True)
    await b.sync()
    assert b.adapter.items == {"x": {"v": 1}}
    assert b.store.conflict_ids("prompts") == {"x"}


async def test_a_record_whose_signature_does_not_match_is_reported(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}})
    await b.sync()
    _forged(server, "x", device="dev-a", deleted=True)
    result = await b.sync()
    assert result["refused"] == ["x"]
    assert b.adapter.items == {"x": {"v": 1}}


# ── rows the server would not put in a frame (tooLarge stubs) ────────────────
def _stub(item_id: str, rev: int) -> dict:
    return {"itemId": item_id, "rev": rev, "updatedAt": "t", "deviceId": "dev-a",
            "deleted": 0, "body": None, "sig": None, "tooLarge": True}


async def test_a_too_large_stub_in_a_pull_is_reported_not_applied(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"big": {"v": "local"}})
    await b.sync()
    a = Device(tmp_path, server, "dev-a", {"after": {"v": 2}})
    await a.sync()
    forward = b.engine._request

    async def request(msg_type, payload):
        reply = await forward(msg_type, payload)
        if msg_type == "sync.pull":
            items = reply["payload"]["items"]
            reply["payload"]["items"] = [_stub("big", 99)] + items
            reply["payload"]["cursor"] = max(99, reply["payload"]["cursor"])
        return reply

    b.engine._request = request
    result = await b.sync()
    assert result["tooLarge"] == ["big"] and result["ok"] is True
    assert b.adapter.items["big"] == {"v": "local"}   # not a delete, not applied
    assert b.adapter.items["after"] == {"v": 2}
    assert b.store.cursor("prompts") >= 99             # the cursor moves on
    assert b.store.conflict_ids("prompts") == set()


async def test_a_too_large_stub_in_a_push_conflict_is_not_a_delete(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"big": {"v": 1}})
    forward = b.engine._request

    async def request(msg_type, payload):
        if msg_type == "sync.push":
            return {"ok": True, "payload": {"scope": "prompts", "cursor": 5, "accepted": [],
                                            "conflicts": [_stub("big", 5)]}}
        return await forward(msg_type, payload)

    b.engine._request = request
    result = await b.sync()
    assert result["tooLarge"] == ["big"]
    assert b.store.conflict_ids("prompts") == set()
    assert b.adapter.items == {"big": {"v": 1}}


# ── B6: a round that began under the previous account writes nothing ─────────
async def test_a_round_that_outlives_an_account_switch_writes_nothing(tmp_path, account_key):
    import asyncio

    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"x": {"v": 1}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")
    forward = b.engine._request

    async def request(msg_type, payload):
        reply = await forward(msg_type, payload)
        if msg_type == "sync.pull":
            # The account changes while this round is on the wire — on another
            # task, outside this round's context (run_in_executor copies none).
            def switch():
                b.store.new_generation()
                b.store.forget("prompts")

            await asyncio.get_running_loop().run_in_executor(None, switch)
        return reply

    b.engine._request = request
    result = await b.engine.sync_all()
    assert result[0]["ok"] is False and "account changed" in result[0]["error"]
    assert b.store.cursor("prompts") == 0 and b.store.states("prompts") == {}


async def test_a_reset_inside_a_round_does_not_count_as_a_switch(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}})
    await b.sync()
    b.store.set_cursor("prompts", 50)  # beyond the server: the next pull resets
    result = await b.sync()
    assert result["ok"] is True


async def test_rounds_started_by_a_kick_can_be_cancelled(tmp_path, account_key):
    import asyncio

    server = FakeServer()
    b = Device(tmp_path, server, "dev-b")
    gate = asyncio.Event()
    forward = b.engine._request

    async def request(msg_type, payload):
        await gate.wait()
        return await forward(msg_type, payload)

    b.engine._request = request
    b.engine._kick("prompts")
    await asyncio.sleep(0)
    assert b.engine._kicked
    b.engine.cancel_rounds()
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert all(t.done() for t in list(b.engine._kicked)) or not b.engine._kicked


# ── X-4: after a rotation, nothing stays under a key that is not the active one
async def test_a_v1_record_is_resealed_after_a_rotation(tmp_path, account_key):
    from agent_team_backend import sync_keyring

    from .test_sync_keyring import _v1_body

    server = FakeServer()
    payload = {"id": "p1", "prompt": "hello"}
    server.rows[("prompts", "p1")] = {
        "itemId": "p1", "rev": 1, "updatedAt": "t", "deviceId": "old-dev", "deleted": 0,
        "body": _v1_body(sync_keyring.account_key(), sync_engine.canonical(payload),
                         scope="prompts", item_id="p1"),
        "sig": "",
    }
    server.cursors["prompts"] = 1
    a = Device(tmp_path, server, "dev-a")
    await a.sync()
    assert a.adapter.items == {"p1": payload}
    # Before any rotation a v1 body is left alone: older devices read only v1.
    await a.sync()
    assert server.rows[("prompts", "p1")]["rev"] == 1
    sync_keyring.rotate_account_key()
    await a.sync()
    body = server.rows[("prompts", "p1")]["body"]
    assert not sync_keyring.needs_reseal(body)
    assert server.rows[("prompts", "p1")]["rev"] > 1


async def test_a_record_pulled_under_a_retired_key_is_resealed(tmp_path, account_key):
    # A device that had not yet received the new ring wrote under the old key.
    from agent_team_backend import sync_keyring

    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"x": {"v": 1}})
    await a.sync()  # sealed under the key that is about to be retired
    b = Device(tmp_path, server, "dev-b")
    sync_keyring.rotate_account_key()
    await b.sync()
    await b.sync()
    assert not sync_keyring.needs_reseal(server.rows[("prompts", "x")]["body"])


# ── F4b: a server cannot make a scope start over every round ─────────────────
async def test_a_second_reset_within_the_hour_is_refused_and_reported(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {f"p{i}": {"n": i} for i in range(5)})
    await b.sync()
    clock = _Clock()
    b.engine._clock = clock
    forward = b.engine._request

    async def request(msg_type, payload):
        reply = await forward(msg_type, payload)
        if msg_type == "sync.pull" and int(payload.get("since") or 0) > 0:
            reply["payload"] = dict(reply["payload"], cursor=0)
        return reply

    b.engine._request = request
    first = await b.sync()
    assert not first.get("resetThrottled")
    before = b.store.states("prompts")
    second = await b.sync()
    assert second["resetThrottled"] is True
    assert b.store.states("prompts") == before          # nothing forgotten
    clock.now += 2 * 3600
    third = await b.sync()
    assert not third.get("resetThrottled")


# ── security re-review (sync審-資安, round 2) ────────────────────────────────
async def test_a_round_queued_across_an_account_switch_writes_nothing(tmp_path, account_key):
    # R-B1: it passed its checks under A, waited for the lock, and must not
    # then run under B's generation.
    import asyncio

    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"a-only": {"v": 1}})
    lock = b.engine._locks.setdefault("prompts", asyncio.Lock())
    await lock.acquire()
    queued = asyncio.create_task(b.sync())
    await asyncio.sleep(0.05)
    b.store.new_generation()
    lock.release()
    with pytest.raises(sync_engine.StaleRound):
        await queued
    assert server.rows == {}


async def test_a_pending_delete_survives_a_too_large_stub(tmp_path, account_key):
    # R-A1 (a): the re-read after a reset brings the deleted item back as a stub.
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}, "y": {"v": 1}})
    await b.sync()
    b.adapter.items.pop("x")
    forward = b.engine._request
    lied = False

    async def request(msg_type, payload):
        nonlocal lied
        reply = await forward(msg_type, payload)
        if msg_type == "sync.pull" and int(payload.get("since") or 0) > 0 and not lied:
            lied = True
            reply["payload"] = dict(reply["payload"], cursor=0, items=[], more=False)
        elif msg_type == "sync.pull":
            reply["payload"]["items"] = [
                dict(_stub("x", r["rev"]), deviceId=r["deviceId"]) if r["itemId"] == "x" else r
                for r in reply["payload"]["items"]
            ]
        return reply

    b.engine._request = request
    await b.sync()
    await b.sync()
    assert server.rows[("prompts", "x")]["deleted"] == 1


async def test_a_pending_delete_survives_a_round_cut_short(tmp_path, account_key, monkeypatch):
    # R-A1 (b): the re-read stops at the page cap before reaching the item.
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}, "y": {"v": 1}, "z": {"v": 1}})
    await b.sync()
    b.adapter.items.pop("z")  # rev 3: the last page of the re-read
    monkeypatch.setattr(sync_engine, "PULL_PAGE", 1)
    monkeypatch.setattr(sync_engine, "MAX_PULL_PAGES", 1)
    forward = b.engine._request
    lied = False

    async def request(msg_type, payload):
        nonlocal lied
        reply = await forward(msg_type, payload)
        if msg_type == "sync.pull" and int(payload.get("since") or 0) > 0 and not lied:
            lied = True
            reply["payload"] = dict(reply["payload"], cursor=0, items=[], more=False)
        return reply

    b.engine._request = request
    for _ in range(5):
        await b.sync()
    assert "z" not in b.adapter.items
    assert server.rows[("prompts", "z")]["deleted"] == 1
    assert b.store.conflict_ids("prompts") == set()


async def test_push_items_waits_for_the_running_round_and_checks_the_generation(tmp_path, account_key):
    # R-B2.
    import asyncio

    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}})
    lock = b.engine._locks.setdefault("prompts", asyncio.Lock())
    await lock.acquire()
    task = asyncio.create_task(b.engine.push_items("prompts", ["x"]))
    await asyncio.sleep(0.05)
    assert server.pushes == 0   # waiting behind the round
    b.store.new_generation()
    lock.release()
    with pytest.raises(sync_engine.StaleRound):
        await task
    assert server.pushes == 0


async def test_pull_items_records_nothing_once_the_account_changed(tmp_path, account_key):
    import asyncio

    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"x": {"v": 1}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")
    forward = b.engine._request

    async def request(msg_type, payload):
        reply = await forward(msg_type, payload)
        await asyncio.get_running_loop().run_in_executor(None, b.store.new_generation)
        return reply

    b.engine._request = request
    with pytest.raises(sync_engine.StaleRound):
        await b.engine.pull_items("prompts", ["x"])
    assert b.adapter.items == {}


async def test_a_stale_round_never_reaches_the_adapter(tmp_path, account_key):
    # R-B3: no apply (and so no detach) once the round is stale.
    import asyncio

    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"x": {"v": 1}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")
    applied: list[str] = []
    b.adapter.apply = lambda item_id, payload: applied.append(item_id)
    forward = b.engine._request

    async def request(msg_type, payload):
        reply = await forward(msg_type, payload)
        if msg_type == "sync.pull":
            await asyncio.get_running_loop().run_in_executor(None, b.store.new_generation)
        return reply

    b.engine._request = request
    await b.engine.sync_all()
    assert applied == []


async def test_an_unsigned_record_claiming_to_be_ours_is_dropped(tmp_path, account_key):
    # R-A3: this release always signs; an unsigned "own" row is not ours.
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}})
    await b.sync()
    before = b.store.state("prompts", "x")
    _unsigned(server, "x", None, device="dev-b", deleted=True)
    result = await b.sync()
    assert result["refused"] == ["x"]
    assert b.store.state("prompts", "x") == before


async def test_errors_are_reported_by_class_not_by_their_text(tmp_path, account_key, caplog):
    # R-B5: an exception's text can carry what it failed on.
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b")

    def snapshot():
        raise RuntimeError("token sk-live-123 in the way")

    b.adapter.snapshot = snapshot
    with caplog.at_level("WARNING"):
        [result] = await b.engine.sync_all()
    assert result["ok"] is False
    assert "sk-live-123" not in result["error"] and "RuntimeError" in result["error"]
    assert "sk-live-123" not in caplog.text


# ── round 3: what the engine remembers in memory belongs to one account ──────
async def test_a_delete_remembered_under_one_account_never_reaches_the_next(tmp_path, account_key):
    srv_a = FakeServer()
    b = Device(tmp_path, srv_a, "dev-b", {"x": {"v": "A"}, "y": {"v": 1}})
    await b.sync()
    b.adapter.items.pop("x")
    forward = b.engine._request
    pulls = 0

    async def request_a(msg_type, payload):
        nonlocal pulls
        reply = await forward(msg_type, payload)
        if msg_type == "sync.pull":
            pulls += 1
            if pulls == 1:
                reply["payload"] = dict(reply["payload"], cursor=0, items=[], more=False)
            else:
                raise ConnectionError("link dropped during the reset round")
        return reply

    b.engine._request = request_a
    with pytest.raises(ConnectionError):
        await b.sync()
    b.store.new_generation()      # the account changes
    b.store.forget("prompts")
    srv_b = FakeServer()
    other = Device(tmp_path, srv_b, "dev-c", {"x": {"v": "B-owned"}})
    await other.sync()
    from .test_sync_engine_core import _as_device

    b.engine._request = _as_device("dev-b", srv_b)
    await b.sync()
    assert not srv_b.rows[("prompts", "x")]["deleted"]
    await other.sync()
    assert other.adapter.items["x"] == {"v": "B-owned"}


async def test_a_reset_under_one_account_does_not_throttle_the_next(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}})
    await b.sync()
    b.engine._last_reset["prompts"] = b.engine._clock()
    b.store.new_generation()
    b.store.set_cursor("prompts", 50)  # the next account's server is behind us
    result = await b.sync()
    assert not result["resetThrottled"]


def test_round_is_current_follows_the_store_generation(tmp_path):
    import asyncio

    from agent_team_backend.db import Database

    store = sync_engine.SyncStore(Database(tmp_path / "g.db"))
    assert sync_engine.round_is_current() is True   # outside any round
    seen: list[bool] = []

    async def inside():
        token = sync_engine._round_generation.set((store, store.generation))
        try:
            seen.append(sync_engine.round_is_current())
            store.new_generation()
            seen.append(sync_engine.round_is_current())
        finally:
            sync_engine._round_generation.reset(token)

    asyncio.run(inside())
    assert seen == [True, False]


# ── a pull page over one WebSocket frame on a server with no byte cap ────────
async def _rounds(device, n):
    """``n`` rounds; True for one that went through, the exception otherwise."""
    out = []
    for _ in range(n):
        try:
            await device.sync()
            out.append(True)
        except Exception as err:  # noqa: BLE001 - recorded for the assertions
            out.append(err)
    return out


async def test_a_page_too_big_for_one_frame_halves_until_it_fits_then_recovers(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {f"p{i}": {"n": i} for i in range(10)})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")
    forward = b.engine._request
    full = b.engine._pull_limit("prompts")
    fits = 3
    limits: list[int] = []

    async def request(msg_type, payload):
        if msg_type == "sync.pull":
            limits.append(payload["limit"])
            if payload["limit"] > fits:
                # What the link raises when the socket closed with 1009.
                raise sync_engine.FrameTooLarge("navide-server connection closed")
        return await forward(msg_type, payload)

    b.engine._request = request
    halvings, n = [], full
    while n > fits:
        halvings.append(n)
        n = max(1, n // 2)
    outcomes = await _rounds(b, len(halvings) + 1)
    assert limits[: len(halvings) + 1] == [*halvings, n]
    assert all(isinstance(o, sync_engine.FrameTooLarge) for o in outcomes[:-1])
    assert outcomes[-1] is True
    assert b.adapter.items == a.adapter.items
    # A whole pull went through: the page is back to the size the rows suggest.
    assert b.engine._pull_limit("prompts") == full


async def test_halving_stops_at_one_row(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b")
    limits: list[int] = []

    async def request(msg_type, payload):
        if msg_type == "sync.pull":
            limits.append(payload["limit"])
        raise sync_engine.FrameTooLarge("navide-server connection closed")

    b.engine._request = request
    await _rounds(b, 12)
    assert limits[-2:] == [1, 1]
    assert all(later <= earlier for earlier, later in zip(limits, limits[1:]))


async def test_an_ordinary_drop_does_not_shrink_the_page(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b")
    full = b.engine._pull_limit("prompts")

    async def request(msg_type, payload):
        raise ConnectionError("navide-server connection closed")

    b.engine._request = request
    await _rounds(b, 3)
    assert b.engine._pull_limit("prompts") == full
