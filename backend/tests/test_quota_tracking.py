"""Quota evidence, bounded history, retained coverage and late-event regressions."""
from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import datetime, timezone

import pytest

from agent_team_backend.db import Database
from agent_team_backend.quota_ledger import QuotaLedger, SLICES_SINCE_KEY, _create_schema
from agent_team_backend.tokens_store import SLICE_RETENTION_S, TokensStore

T0 = 1789948800.0  # Monday 2026-09-21 00:00 UTC
H = 3600


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace('+00:00', 'Z')


def snap(pct, reset, at, kind='session', label='Session'):
    return {'status': 'ok', 'fetchedAt': iso(at), 'windows': [
        {'kind': kind, 'label': label, 'usedPercent': pct, 'resetsAt': iso(reset)}]}


@pytest.fixture
def rig(tmp_path, monkeypatch):
    clock = [T0]
    monkeypatch.setattr('time.time', lambda: clock[0])
    db = Database(tmp_path / 'test.db')
    db.kv_set(SLICES_SINCE_KEY, T0 - 10 * 86400, now=0)
    store = TokensStore(global_path=tmp_path / 'tokens.json', workspace_base_dir=tmp_path / 'ws', db=db)
    ledger = QuotaLedger(db, store.account_window_totals)
    yield clock, db, store, ledger
    store.flush()
    db.close()


def test_legacy_migration_preserves_low_peaks_and_is_repeatable(tmp_path):
    db = Database(tmp_path / 'test.db')
    db.migrate('quota_ledger', 1, _create_schema)
    with db.transaction() as cur:
        for pct, at in [(89, T0), (9, T0), (4, None)]:
            cur.execute('INSERT INTO quota_cycles (agent,profile_id,window_kind,resets_at,max_percent,exhausted_at) VALUES (?,?,?,?,?,?)',
                        ('claude', 'a', f'window-{pct}', T0 + H, pct, at))
    for _ in range(2):
        ledger = QuotaLedger(db, lambda *_: {})
        rows = ledger.cycles('claude', 'a', now=T0)
        assert {r['max_percent']: (r['exhausted_at'], r['exhausted_source']) for r in rows} == {
            89: (iso(T0), 'legacy_unknown'), 9: (iso(T0), 'legacy_unknown'), 4: (None, None)}
    db.close()


def test_earliest_evidence_and_source_move_together(rig):
    clock, db, store, ledger = rig
    reset = T0 + 5 * H
    ledger.observe('claude', 'a', snap(89, reset, T0 + H), now=T0 + H)
    assert ledger.mark_exhausted('claude', 'a', T0 + 2 * H, reset,
                                 window_kind='session', reset_precision='minute') == ['session']
    row = ledger.cycles('claude', 'a', now=T0 + 3 * H)[0]
    assert row['max_percent'] == 89 and row['exhausted_source'] == 'cli'
    ledger.observe('claude', 'a', snap(100, reset, T0 + 3 * H), now=T0 + 3 * H)
    assert ledger.cycles('claude', 'a', now=T0 + 3 * H)[0]['exhausted_source'] == 'cli'
    # Earlier full sample, even if its percentage/reset duplicates the last reading.
    ledger.observe('claude', 'a', snap(100, reset, T0 + H), now=T0 + 3 * H)
    row = QuotaLedger(db, store.account_window_totals).cycles('claude', 'a', now=T0 + 3 * H)[0]
    assert (row['exhausted_at'], row['exhausted_source']) == (iso(T0 + H), 'sample')
    assert ledger.mark_exhausted('claude', 'a', T0 + H, reset,
                                 window_kind='session', reset_precision='exact') == []


def test_weekly_clock_cannot_hit_monday_session_and_no_peak_guess(rig):
    _, _, _, ledger = rig
    session_reset = T0 + 15 * H + 40 * 60
    weekly_reset = T0 + 3 * 86400 + 15 * H + 30 * 60
    at = T0 + 11 * H
    for kind, label, pct, reset in [('session', 'Session', 89, session_reset),
                                  ('weekly', 'Weekly', 98, weekly_reset),
                                  ('weekly-model', 'Opus only', 9, weekly_reset)]:
        ledger.observe('claude', 'a', snap(pct, reset, at, kind, label), now=at)
    assert ledger.mark_exhausted('claude', 'a', at, T0 + 15 * H + 30 * 60,
                                 window_kind='weekly', reset_precision='clock_only') == []
    assert ledger.mark_exhausted('claude', 'a', at, weekly_reset, reset_precision='minute') == []
    assert ledger.mark_exhausted('claude', 'a', at, weekly_reset,
                                 window_kind='weekly', reset_precision='minute') == []
    assert ledger.mark_exhausted('claude', 'a', at, weekly_reset,
                                 window_kind='weekly', model_scope='Opus', reset_precision='minute') == ['weekly-model:Opus only']
    assert ledger.mark_exhausted('claude', 'a', at, session_reset - 600,
                                 window_kind='session', reset_precision='minute') == []
    assert ledger.mark_exhausted('claude', 'a', at, session_reset - 600,
                                 window_kind='session', reset_precision='hour') == ['session']


def test_late_event_reconciles_only_affected_closed_cycles_and_survives_expiry(rig, tmp_path):
    clock, _, store, ledger = rig
    for profile in ('a', 'b'):
        ledger.observe('claude', profile, snap(100, T0 + 5 * H, T0 + H), now=T0 + H)
    store.record(str(tmp_path), source='cli', vendor='claude', profile_id='a',
                 input_tokens=100, output_tokens=0, timestamp=iso(T0 + H), dedup_key='one')
    clock[0] = T0 + 6 * H
    ledger.close_expired()
    before = ledger.cycles('claude', 'a')[0]
    assert before['total'] == 100 and before['closed']
    store.record(str(tmp_path), source='cli', vendor='claude', profile_id='a',
                 input_tokens=23, output_tokens=0, timestamp=iso(T0 + 2 * H), dedup_key='late')
    assert ledger.reconcile_pending(store) == [('claude', 'a', 'session')]
    after = ledger.cycles('claude', 'a')[0]
    assert after['total'] == 123 and after['closed'] and after['reconciled_at'] == iso(clock[0])
    assert ledger.cycles('claude', 'b')[0]['total'] == 0
    assert ledger.reconcile_pending(store) == []
    clock[0] += SLICE_RETENTION_S + 86400
    assert ledger.cycles('claude', 'a')[0]['total'] == 123
    # An old cycle first closed after its data expires cannot become known zero.
    ledger.observe('claude', 'c', snap(100, T0 + 5 * H, T0 + H))
    old = ledger.cycles('claude', 'c')[0]
    assert old['coverage_state'] == 'unavailable' and old['coverage_reason'] == 'retention_expired'
    assert old['total'] is None and not old['average_eligible']


def test_partial_collection_and_bucket_start_semantics(rig, tmp_path):
    clock, _, store, ledger = rig
    store.slices_since = T0 + 100
    ledger.observe('claude', 'a', snap(89, T0 + 5 * H, T0 + H), now=T0 + H)
    store.record(str(tmp_path), source='cli', vendor='claude', profile_id='a',
                 input_tokens=17, output_tokens=0, timestamp=iso(T0 + 301), dedup_key='partial')
    clock[0] = T0 + H
    row = ledger.cycles('claude', 'a')[0]
    assert row['coverage_state'] == 'partial' and row['total'] is None
    assert row['recorded_totals']['total'] == 17 and row['bucket_seconds'] == 300
    assert store.account_window_totals('claude', 'a', T0 + 302, T0 + 600)['total'] == 0


def test_range_pages_export_cutoff_and_completed_average(rig):
    clock, db, _, ledger = rig
    for n in range(55):
        start = T0 - (55 - n) * 5 * H
        ledger.observe('claude', 'a', snap(100, start + 5 * H, start + H), now=start + H)
    clock[0] = T0
    page = ledger.query_cycles('claude', 'a', range_start=iso(T0 - 30 * 86400), range_end=iso(T0 + 1))
    assert len(page['cycles']) == 50 and page['total_count'] == 55
    assert page['summary']['session']['eligible_count'] > 0
    with db.transaction() as cur:
        cur.execute("INSERT INTO quota_cycles(agent,profile_id,window_kind,started_at,resets_at) VALUES ('claude','a','session',?,?)", (T0 - 20 * H, T0 - 15 * H + 1))
    second = ledger.query_cycles('claude', 'a', range_start=page['range_start'], range_end=page['range_end'],
                                 snapshot=page['snapshot'], cursor=page['next_cursor'])
    assert len(second['cycles']) == 5 and second['summary'] == page['summary']
    assert len({c['id'] for c in page['cycles'] + second['cycles']}) == 55
    ledger.observe('claude', 'a', snap(100, T0 + 7 * 86400, T0, 'weekly'), now=T0)
    current = ledger.query_cycles('claude', 'a')
    assert current['summary']['weekly']['exclusions']['ongoing'] == 1
    assert current['summary']['weekly']['avg_total_exhausted'] is None


@pytest.mark.asyncio
async def test_non_claude_switch_after_fetch_keeps_original_ledger_identity(tmp_path, monkeypatch):
    from agent_team_backend import app, usage_service as us
    svc = us.UsageService(cache_path=tmp_path / 'cache.json')
    active = ['a']
    monkeypatch.setattr(us, '_active_profile_id', lambda _provider: active[0])
    captured = []
    class Ledger:
        def observe(self, agent, profile, snapshot):
            if snapshot.get('status') == 'ok':
                captured.append((agent, profile, snapshot['fetchedAt']))
            return []
    monkeypatch.setattr(app, 'quota_ledger', Ledger())
    async def nothing(*_):
        return None
    monkeypatch.setattr(svc, '_harvest_active_slots', nothing)
    monkeypatch.setattr(svc, '_claude_credentials_by_slot', nothing)
    monkeypatch.setattr(svc, '_notify_failover', lambda *_: None)
    async def claude(_):
        return us._snapshot('claude', 'no-credentials')
    monkeypatch.setattr(us, 'fetch_claude', claude)
    async def codex(_):
        return snap(89, T0 + 5 * H, T0 + H)
    async def slower(_):
        # Let codex's result be accepted first, then switch while another fetch is awaited.
        while 'a' not in svc.account_snapshots.get('codex', {}):
            await asyncio.sleep(0)
        active[0] = 'b'
        svc.begin_switch_epoch('codex', 'b')
        return us._snapshot('grok', 'no-credentials')
    monkeypatch.setattr(us, '_CLI_VENDORS', {
        'codex': replace(us._CLI_VENDORS['codex'], fetch_usage=codex),
        'grok': replace(us._CLI_VENDORS['grok'], fetch_usage=slower),
    })
    await svc.poll_once(tmp_path)
    assert captured == [('codex', 'a', iso(T0 + H))]


@pytest.mark.asyncio
async def test_switch_during_non_claude_fetch_drops_result_without_relabelling_cache(tmp_path, monkeypatch):
    from agent_team_backend import app, usage_service as us
    svc = us.UsageService(cache_path=tmp_path / 'cache.json')
    active = ['a']
    old = snap(40, T0 + 5 * H, T0 + H)
    svc.snapshots['codex'] = old
    svc.account_snapshots['codex'] = {'a': {**old, 'stale': False}}
    entered, release = asyncio.Event(), asyncio.Event()
    captured = []
    class Ledger:
        def observe(self, agent, profile, snapshot):
            if snapshot.get('status') == 'ok':
                captured.append((agent, profile, snapshot['windows'][0]['usedPercent']))
            return []
    monkeypatch.setattr(app, 'quota_ledger', Ledger())
    monkeypatch.setattr(us, '_active_profile_id', lambda _: active[0])
    async def nothing(*_):
        return None
    async def no_claude(_):
        return us._snapshot('claude', 'no-credentials')
    async def reading(_):
        entered.set()
        await release.wait()
        return snap(99, T0 + 5 * H, T0 + 2 * H)
    monkeypatch.setattr(svc, '_harvest_active_slots', nothing)
    monkeypatch.setattr(svc, '_claude_credentials_by_slot', nothing)
    monkeypatch.setattr(svc, '_notify_failover', lambda *_: None)
    monkeypatch.setattr(us, 'fetch_claude', no_claude)
    monkeypatch.setattr(us, '_CLI_VENDORS', {'codex': replace(us._CLI_VENDORS['codex'], fetch_usage=reading)})
    task = asyncio.create_task(svc.poll_once(tmp_path))
    await entered.wait()
    active[0] = 'b'
    svc.begin_switch_epoch('codex', 'b')
    release.set()
    await task
    assert captured == [('codex', 'a', 40)]
    assert svc.account_snapshots['codex']['b']['status'] == 'not-measured'
    # A fresh poll under the new epoch is the only path that can credit B.
    captured.clear()
    await svc.poll_once(tmp_path)
    assert ('codex', 'b', 99) in captured
    assert ('codex', 'a', 99) not in captured


def test_export_is_single_full_materialized_response_with_matching_summary(rig, tmp_path):
    clock, _, store, ledger = rig
    for n in range(55):
        start = T0 - (55 - n) * 5 * H
        ledger.observe('claude', 'a', snap(100, start + 5 * H, start + H), now=start + H)
    clock[0] = T0
    export = ledger.query_cycles('claude', 'a', export=True)
    assert len(export['cycles']) == export['total_count'] == 54  # reset exactly at range_end is excluded
    assert export['next_cursor'] is None
    assert export['summary'] == ledger.summarize(export['cycles'])
    old = export['cycles'][0]
    store.record(str(tmp_path), source='cli', vendor='claude', profile_id='a', input_tokens=7,
                 output_tokens=0, timestamp=iso(T0 - 7 * H), dedup_key='during-export')
    ledger.reconcile_pending(store)
    fresh = ledger.query_cycles('claude', 'a', export=True)
    assert fresh['cycles'][0]['total'] == 7 and old['total'] == 0
    assert export['summary'] == ledger.summarize(export['cycles'])
    with pytest.raises(ValueError, match='export-requires-fresh-query'):
        ledger.query_cycles('claude', 'a', export=True, snapshot=export['snapshot'])


def test_summary_exclusion_reasons_are_exhaustive_and_disjoint(rig):
    _, _, _, ledger = rig
    ledger.observe('claude', 'a', snap(100, T0 + 5 * H, T0 + H), now=T0 + H)
    row = ledger.cycles('claude', 'a', now=T0 + 6 * H)[0]
    cycles = [row,
              {**row, 'closed': False},
              {**row, 'exhausted_at': None},
              {**row, 'exhausted_source': 'legacy_unknown'},
              {**row, 'detail_known': False, 'total': None}]
    summary = ledger.summarize(cycles)['session']
    assert summary['eligible_count'] == 1 and summary['excluded_count'] == 4
    assert summary['exclusions'] == {'ongoing': 1, 'no_limit': 1, 'untrusted_source': 1, 'unavailable_detail': 1}
    assert summary['avg_total_exhausted'] == 0


@pytest.mark.asyncio
async def test_history_identity_query_and_period_range_are_local_and_bounded(rig, tmp_path, monkeypatch):
    from agent_team_backend import app
    from .test_ws_handlers_account_dimensions import _call
    clock, _, store, ledger = rig
    monkeypatch.setattr(app, 'tokens_store', store)
    monkeypatch.setattr(app, 'quota_ledger', ledger)
    store.slices_since = T0 - 100 * 86400
    for i, (profile, stamp) in enumerate([('removed', '2026-08-31T23:59:59Z'),
                                         ('removed', '2026-09-01T00:00:00Z'),
                                         ('unknown', '2026-09-01T00:00:00Z')]):
        store.record(str(tmp_path), source='cli', vendor='claude', profile_id=profile,
                     input_tokens=10, output_tokens=0, timestamp=stamp, dedup_key=f'p{i}')
    ledger.observe('claude', 'ledger-only', snap(89, T0 + 5 * H, T0), now=T0)
    identities = await _call('tokens.quota_accounts')
    assert {r['profile_id'] for r in identities['accounts']} == {'removed', 'unknown', 'ledger-only'}
    reply = await _call('tokens.account_periods', range_start='2026-08-31T12:00:00Z',
                        range_end='2026-09-02T00:00:00Z', limit=1)
    assert reply['total_count'] == 4 and len(reply['rows']) == 1 and reply['next_offset'] == 1
    assert reply['effective_range_start'] == '2026-08-01T00:00:00Z'
    assert reply['effective_range_end'] == '2026-10-01T00:00:00Z'
    second = await _call('tokens.account_periods', range_start=reply['range_start'], range_end=reply['range_end'],
                         limit=1, offset=1)
    assert second['summary'] == reply['summary']
    assert second['totals_by_period'] == reply['totals_by_period']
    full = await _call('tokens.account_periods', range_start=reply['range_start'], range_end=reply['range_end'], export=True)
    assert len(full['rows']) == 4 and full['next_offset'] is None
    assert sum(r['total'] for r in full['rows']) == 30
    assert full['calendar_timezone'] == 'UTC' and full['token_time_key'] == 'event_time'
    assert full['cycle_time_key'] == 'started_at_or_resets_at'
    # A gap makes headline tokens null while retaining the explicitly recorded subtotal.
    store.slices_since = T0 - H
    partial = await _call('tokens.account_periods', profile_id='removed',
                          range_start='2026-09-01T00:00:00Z', range_end='2026-10-01T00:00:00Z')
    assert partial['rows'][0]['total'] is None
    assert partial['rows'][0]['recorded_totals']['total'] == 10
    assert partial['totals_by_period'][0]['total'] is None


@pytest.mark.asyncio
async def test_message_resolves_historical_account_and_requires_precision(rig, monkeypatch):
    from agent_team_backend import app
    from agent_team_backend.pane_account_history import PaneAccountHistory
    from .test_ws_handlers_account_dimensions import _call
    _, db, store, ledger = rig
    history = PaneAccountHistory(db)
    history.pin('pane', 'a', ts=T0)
    history.pin('pane', 'b', ts=T0 + 2 * H)
    monkeypatch.setattr(app, 'tokens_store', store)
    monkeypatch.setattr(app, 'quota_ledger', ledger)
    monkeypatch.setattr(app, 'pane_account_history', history)
    async def broadcast(*_, **__):
        pass
    monkeypatch.setattr(app, 'broadcast', broadcast)
    for profile in ('a', 'b'):
        ledger.observe('claude', profile, snap(89, T0 + 5 * H, T0 + H), now=T0 + H)
    payload = dict(agent_key='claude', pane_id='pane', at=iso(T0 + H), resets_at=iso(T0 + 5 * H), window_kind='session')
    assert (await _call('tokens.quota_exhausted', **payload))['updated'] == []
    assert (await _call('tokens.quota_exhausted', **payload, reset_precision='minute'))['updated'] == ['session']
    assert ledger.cycles('claude', 'a', now=T0 + 3 * H)[0]['exhausted_source'] == 'cli'
    assert ledger.cycles('claude', 'b', now=T0 + 3 * H)[0]['exhausted_at'] is None


@pytest.mark.asyncio
async def test_token_broadcast_reconciles_late_data_and_notifies_cycle_subscribers(rig, tmp_path, monkeypatch):
    from agent_team_backend import app
    clock, _, store, ledger = rig
    ledger.observe('claude', 'a', snap(100, T0 + 5 * H, T0 + H), now=T0 + H)
    clock[0] = T0 + 6 * H
    ledger.close_expired()
    monkeypatch.setattr(app, 'tokens_store', store)
    monkeypatch.setattr(app, 'quota_ledger', ledger)
    monkeypatch.setattr(app, '_pending_tokens_broadcast', set())
    monkeypatch.setattr(app, '_TOKENS_BROADCAST_DEBOUNCE_SEC', 0)
    notified = asyncio.Event()
    events = []
    async def broadcast(event):
        events.append(event)
        if event['type'] == 'tokens.quota_cycles_changed':
            notified.set()
    async def tokens_changed(workspace_path):
        events.append({'type': 'tokens.changed', 'payload': {'workspace_path': workspace_path}})
    monkeypatch.setattr(app, 'broadcast', broadcast)
    monkeypatch.setattr(app, 'broadcast_tokens_changed', tokens_changed)
    store.record(str(tmp_path), source='cli', vendor='claude', profile_id='a',
                 input_tokens=19, output_tokens=0, timestamp=iso(T0 + H), dedup_key='late-broadcast')
    app._schedule_tokens_broadcast(str(tmp_path))
    await asyncio.wait_for(notified.wait(), timeout=3)
    assert [event['type'] for event in events] == ['tokens.changed', 'tokens.quota_cycles_changed']
    assert events[-1]['payload'] == {'agent_key': 'claude', 'profile_id': 'a', 'window_kind': 'session'}
    row = ledger.cycles('claude', 'a')[0]
    assert row['closed'] and row['total'] == 19
    assert ledger.reconcile_pending(store) == []


@pytest.mark.parametrize('granularity', ['month', 'year'])
@pytest.mark.parametrize('selected', [None, 'session', 'weekly', 'weekly-model:Sonnet only'])
def test_period_statistics_honor_explicit_weekly_window_without_summing_tokens(
    rig, tmp_path, monkeypatch, granularity, selected,
):
    from agent_team_backend import app
    clock, _, store, ledger = rig
    monkeypatch.setattr(app, 'tokens_store', store)
    monkeypatch.setattr(app, 'quota_ledger', ledger)
    store.slices_since = T0 - 365 * 86400
    store.record(str(tmp_path), source='cli', vendor='claude', profile_id='a',
                 input_tokens=123, output_tokens=0, timestamp=iso(T0 - H), dedup_key='shared-window')
    for kind, label in [('session', 'Session'), ('weekly', 'Weekly'), ('weekly-model', 'Sonnet only')]:
        ledger.observe('claude', 'a', snap(100, T0, T0 - H, kind, label), now=T0 - H)
    clock[0] = T0 + H
    reply = app.account_periods('claude', 'a', granularity, window_kind=selected, export=True)
    [row] = reply['rows']
    for stats in (row, reply['summary']):
        assert (stats['cycles'], stats['exhausted'], stats['eligible_count'], stats['excluded_count']) == (1, 1, 1, 0)
        assert stats['avg_total_exhausted'] == 123
        assert stats['weekly_exhausted'] == (2 if selected is None else int(selected.startswith('weekly')))
    # All overlapping windows see the same account-local 123, but account
    # consumption must be counted once for every filter and calendar view.
    assert row['total'] == reply['totals_by_period'][0]['total'] == 123


@pytest.mark.parametrize('kind,label,selected', [
    ('weekly', 'Weekly', 'weekly'), ('weekly-model', 'Sonnet only', 'weekly-model:Sonnet only'),
])
@pytest.mark.parametrize('excluded', ['ongoing', 'no_limit', 'untrusted_source', 'unavailable_detail'])
def test_selected_weekly_average_still_excludes_unusable_cycles(
    rig, tmp_path, monkeypatch, kind, label, selected, excluded,
):
    from agent_team_backend import app
    clock, db, store, ledger = rig
    monkeypatch.setattr(app, 'tokens_store', store)
    monkeypatch.setattr(app, 'quota_ledger', ledger)
    store.slices_since = T0 - 365 * 86400
    store.record(str(tmp_path), source='cli', vendor='claude', profile_id='a',
                 input_tokens=123, output_tokens=0, timestamp=iso(T0 - H), dedup_key='excluded-window')
    reset = T0 + 5 * H if excluded == 'ongoing' else T0
    ledger.observe('claude', 'a', snap(89 if excluded == 'no_limit' else 100, reset, T0 - H, kind, label), now=T0 - H)
    clock[0] = T0 + H
    ledger.close_expired()
    with db.transaction() as cur:
        if excluded == 'untrusted_source':
            cur.execute("UPDATE quota_cycles SET exhausted_source = 'legacy_unknown'")
        elif excluded == 'unavailable_detail':
            cur.execute("UPDATE quota_cycles SET coverage_state = 'partial', coverage_reason = 'collection_started_late'")
    reply = app.account_periods('claude', 'a', 'month', window_kind=selected, export=True)
    [row] = reply['rows']
    for stats in (row, reply['summary']):
        assert (stats['cycles'], stats['eligible_count'], stats['excluded_count']) == (1, 0, 1)
        assert stats['avg_total_exhausted'] is None
        assert stats['exclusions'][excluded] == 1
    assert row['total'] == reply['totals_by_period'][0]['total'] == 123
