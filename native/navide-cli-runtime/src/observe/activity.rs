//! Activity: the backend feeds the records past its cursor to a `Walk`,
//! which runs the declaration's rules over each and keeps the state main's
//! readers keep in their `seen_keys` sentinels (the line mark, slots such as
//! the pending reply text, and the inferred-turn tracker) in one
//! `ActivityState`.
use super::{trace, ActivityEvent, Backend, Error, File, Memo};
use crate::decl::{Activity, Clock, Effect, Emit, EventKind, Num, Rule, SlotKey, TurnOp, TurnStamp, Vendor};
use crate::expr::{self, Blob, Scope, Slots};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

/// The open (or last) inferred turn: main's `{idx, ts | last_ms, flushed, cancelled}`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct TurnState {
    pub idx: i64,
    #[serde(default)]
    pub ts: String,
    #[serde(default)]
    pub ms: i64,
    #[serde(default)]
    pub flushed: bool,
    #[serde(default)]
    pub cancelled: bool,
}

/// Everything a file's walks carry from one call to the next.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ActivityState {
    /// Line cursor: the highest line already walked (main's `act_hw::N`).
    #[serde(default)]
    pub hw: usize,
    /// Byte cursor: a JSONL tail checkpoint.
    #[serde(default)]
    pub cursor: Map<String, Value>,
    /// The declaration's kept slots, by their names.
    #[serde(default)]
    pub slots: BTreeMap<String, String>,
    #[serde(default)]
    pub turn: Option<TurnState>,
    /// Row cursor: the highest row id walked; `None` until the database is first seen.
    #[serde(default)]
    pub rows: Option<i64>,
    /// Partitioned row cursor: each partition's highest id walked, and
    /// whether the database's first sight anchored them.
    #[serde(default)]
    pub marks: BTreeMap<String, i64>,
    #[serde(default)]
    pub anchored: bool,
    /// Rows still settling (`RowWalk::revisit`).
    #[serde(default)]
    pub pending: BTreeSet<i64>,
    /// Kept slots the last walk wrote (even with the value they had).
    #[serde(skip)]
    pub written: Vec<String>,
}

enum Flow {
    Go,
    Stop,
}

/// Where a record is: its line (line cursor), the byte offset just past it,
/// and a row's binary columns.
#[derive(Clone, Copy)]
pub struct At<'r> {
    pub line: usize,
    pub end: u64,
    pub fresh: bool,
    pub blobs: &'r [Blob],
}

impl At<'static> {
    pub fn line(line: usize, end: u64) -> Self {
        At { line, end, fresh: true, blobs: &[] }
    }
}

impl<'r> At<'r> {
    pub fn row(blobs: &'r [Blob]) -> Self {
        At { line: 0, end: 0, fresh: true, blobs }
    }
}

/// One pass of a file's rules: the slots, the tracker and the events so far.
pub struct Walk<'a, V: Vendor> {
    pub file: &'a File<'a, V>,
    pub(crate) slots: Slots<V>,
    turn: Option<TurnState>,
    out: Vec<ActivityEvent>,
    written: Vec<V::Slot>,
    now: f64,
    /// The line walk started past the file's first line (`Scope::resumed`).
    pub resumed: bool,
    /// The walk ended at a line that is not UTF-8.
    pub decode_error: Option<usize>,
}

impl<'a, V: Vendor> Walk<'a, V> {
    pub(crate) fn new(file: &'a File<'a, V>, slots: Slots<V>, turn: Option<TurnState>, now: f64) -> Self {
        Walk { file, slots, turn, out: Vec::new(), written: Vec::new(), now, resumed: false, decode_error: None }
    }

    fn spec(&self) -> &'static Activity<V> {
        &self.file.spec.activity
    }

    fn scope<'s>(&'s self, record: &'s Value, at: At<'s>) -> Scope<'s, V> {
        Scope {
            record,
            blobs: at.blobs,
            line: at.line,
            offset: at.end,
            slots: &self.slots,
            cancelled: self.turn.as_ref().is_some_and(|t| t.cancelled),
            entry_key: "",
            now: self.now,
            emitted: self.out.len(),
            fresh: at.fresh,
            resumed: self.resumed,
            totals: (0, 0),
        }
    }

    /// The kept slots back into the walk's slots.
    pub fn restore(&mut self, state: &ActivityState) {
        for kept in self.spec().kept {
            if let Some(value) = state.slots.get(kept.slot.name()) {
                self.slots.set(kept.slot, value.clone());
            }
        }
    }

    /// Every slot write goes through here, so the walk knows what it wrote.
    fn put(&mut self, slot: V::Slot, value: String) {
        self.slots.set(slot, value);
        if !self.written.contains(&slot) {
            self.written.push(slot);
        }
    }

    /// Run the activity rules over one record.
    pub fn record(&mut self, record: &Value, at: At<'_>) {
        self.rules(self.spec().rules, record, at);
    }

    pub(crate) fn rules(&mut self, rules: &'static [Rule<V>], record: &Value, at: At<'_>) {
        for rule in rules {
            if !expr::pred(&rule.when, &self.scope(record, at)) {
                continue;
            }
            trace::matched(rule);
            if let Flow::Stop = self.apply_all(rule.effects, record, at) {
                return;
            }
        }
    }

    pub(crate) fn effects(&mut self, effects: &'static [Effect<V>], record: &Value, at: At<'_>) {
        self.apply_all(effects, record, at);
    }

    fn apply_all(&mut self, effects: &'static [Effect<V>], record: &Value, at: At<'_>) -> Flow {
        for effect in effects {
            if let Flow::Stop = self.apply(effect, record, at) {
                return Flow::Stop;
            }
        }
        Flow::Go
    }

    fn apply(&mut self, effect: &'static Effect<V>, record: &Value, at: At<'_>) -> Flow {
        match effect {
            Effect::Emit(emit) => self.emit(emit, record, at),
            Effect::Set(slot, t) => {
                let value = expr::text(t, &self.scope(record, at));
                self.put(*slot, value);
            }
            Effect::SetIfNonEmpty(slot, t) => {
                let value = expr::text(t, &self.scope(record, at));
                if !value.is_empty() {
                    self.put(*slot, value);
                }
            }
            Effect::Append(slot, t, max) => {
                let more = expr::text(t, &self.scope(record, at));
                if !more.is_empty() {
                    let joined = format!("{}{more}", self.slots.get(*slot));
                    self.put(*slot, expr::cap(&joined, *max));
                }
            }
            Effect::Turn(op) => self.turn_op(op, record, at),
            Effect::When(p, inner) => {
                if expr::pred(p, &self.scope(record, at)) {
                    return self.apply_all(inner, record, at);
                }
            }
            Effect::Stop => return Flow::Stop,
        }
        Flow::Go
    }

    fn event(&self, kind: EventKind) -> ActivityEvent {
        ActivityEvent {
            vendor: self.file.vendor().to_owned(),
            event_type: kind_name(kind).to_owned(),
            cwd: self.slots.of(self.file.spec.cwd).to_owned(),
            session_id: self.slots.of(self.file.spec.session).to_owned(),
            file_path: self.file.path_text(),
            dedup_key: String::new(),
            timestamp: String::new(),
            detail: String::new(),
            text: String::new(),
            full: String::new(),
        }
    }

    fn emit(&mut self, emit: &Emit<V>, record: &Value, at: At<'_>) {
        let s = self.scope(record, at);
        let text = expr::text(&emit.text, &s);
        if emit.require_text && text.is_empty() {
            return;
        }
        let mut event = self.event(emit.kind);
        if let Some(session) = &emit.session {
            event.session_id = expr::text(session, &s);
        }
        event.dedup_key = expr::text(&emit.key, &s);
        event.timestamp = expr::text(&emit.timestamp, &s);
        event.detail = expr::text(&emit.detail, &s);
        event.full = if text.is_empty() { String::new() } else { expr::prompt_full(&emit.text, &s) };
        event.text = text;
        self.out.push(event);
    }

    fn num(&self, n: &Num<V>, record: &Value, at: At<'_>) -> i64 {
        expr::num(n, &self.scope(record, at)).unwrap_or(0)
    }

    fn open_turn(&mut self, ts: String, ms: i64) {
        let idx = self.turn.as_ref().map_or(0, |t| t.idx + 1);
        self.turn = Some(TurnState { idx, ts, ms, flushed: false, cancelled: false });
    }

    /// Close the open turn: one `turn_complete` carrying the pending reply.
    fn close_turn(&mut self, detail: &str, ms: Option<i64>) {
        let spec = self.spec();
        let Some(turn) = self.turn.as_mut().filter(|t| !t.flushed) else { return };
        turn.flushed = true;
        let timestamp = match spec.turn_stamp {
            TurnStamp::Text => turn.ts.clone(),
            TurnStamp::Millis => ms.map_or(turn.ms, |m| turn.ms.max(m)).to_string(),
        };
        let idx = turn.idx;
        let text = self.slots.of(spec.turn_text).to_owned();
        if let Some(slot) = spec.turn_text {
            self.put(slot, String::new());
        }
        let mut event = self.event(EventKind::TurnComplete);
        event.dedup_key = format!("turn:{idx}");
        event.timestamp = timestamp;
        event.detail = detail.to_owned();
        event.text = text;
        self.out.push(event);
    }

    fn turn_op(&mut self, op: &'static TurnOp<V>, record: &Value, at: At<'_>) {
        match op {
            TurnOp::Open { boundary, ts, ms } => {
                self.close_turn(boundary, None);
                let (ts, ms) = (expr::text(ts, &self.scope(record, at)), self.num(ms, record, at));
                self.open_turn(ts, ms);
            }
            TurnOp::EnsureOpen { ts, ms } => {
                if self.turn.as_ref().is_none_or(|t| t.flushed) {
                    let (ts, ms) = (expr::text(ts, &self.scope(record, at)), self.num(ms, record, at));
                    self.open_turn(ts, ms);
                }
            }
            TurnOp::Touch { ts, ms } => {
                let ts = ts.as_ref().map(|t| expr::text(t, &self.scope(record, at)));
                let ms = ms.as_ref().map(|n| self.num(n, record, at));
                if let Some(turn) = self.turn.as_mut().filter(|t| !t.flushed) {
                    if let Some(ts) = ts {
                        turn.ts = ts;
                    }
                    if let Some(ms) = ms {
                        turn.ms = turn.ms.max(ms);
                    }
                }
            }
            TurnOp::Close { detail, ms } => {
                let ms = ms.as_ref().map(|n| self.num(n, record, at));
                self.close_turn(detail, ms);
            }
            TurnOp::Cancel { detail, ms } => {
                let ms = ms.as_ref().map(|n| self.num(n, record, at));
                self.close_turn(detail, ms);
                if let Some(turn) = self.turn.as_mut() {
                    turn.cancelled = true;
                    if let Some(slot) = self.spec().turn_text {
                        self.put(slot, String::new());
                    }
                }
            }
        }
    }
}

fn kind_name(kind: EventKind) -> &'static str {
    match kind {
        EventKind::AgentActive => "agent_active",
        EventKind::TurnComplete => "turn_complete",
        EventKind::SubagentTurnEnd => "subagent_turn_end",
    }
}

/// Run slot effects (`Set`, `When`, …) outside an activity walk: usage and
/// turns keep per-file values with the same vocabulary. What they emit, and
/// what they do to the tracker, has nothing to act on there and is dropped.
pub(crate) fn slot_effects<V: Vendor>(file: &File<'_, V>, effects: &'static [Effect<V>], record: &Value, at: At<'_>, slots: &mut Slots<V>) {
    let mut walk = Walk::new(file, std::mem::take(slots), None, 0.0);
    walk.effects(effects, record, at);
    *slots = walk.slots;
}

/// Run every matching rule's slot effects over one record (turns use this).
pub(crate) fn slot_rules<V: Vendor>(file: &File<'_, V>, rules: &'static [Rule<V>], record: &Value, at: At<'_>, slots: &mut Slots<V>) {
    let mut walk = Walk::new(file, std::mem::take(slots), None, 0.0);
    walk.rules(rules, record, at);
    *slots = walk.slots;
}

/// One walk of the file from `state`: the events, with the state moved on.
pub fn walk<V: Vendor>(file: &File<'_, V>, state: &mut ActivityState, memo: &mut Memo, now: f64) -> Result<Vec<ActivityEvent>, Error> {
    let spec = &file.spec.activity;
    let mut walk = Walk::new(file, file.slots(spec.slots)?, state.turn.take(), now);
    if let Err(err) = V::Backend::walk(&mut walk, state, memo) {
        state.turn = walk.turn;
        return Err(err);
    }
    if walk.decode_error.is_none() {
        if let Some(idle) = &spec.idle {
            let quiet_ms = match idle.clock {
                Clock::FileMtime => std::fs::metadata(file.path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0.0, |mtime| (now - mtime.as_secs_f64()) * 1000.0),
                Clock::TurnMillis => {
                    let since = walk.turn.as_ref().map_or(0, |t| t.ms);
                    ((now * 1000.0) as i64 - since) as f64
                }
            };
            if walk.turn.as_ref().is_some_and(|t| !t.flushed) && quiet_ms >= idle.after_ms as f64 {
                walk.close_turn(idle.detail, None);
            }
        }
    }
    state.turn = walk.turn.take();
    state.slots = spec
        .kept
        .iter()
        .filter(|kept| walk.slots.is_set(kept.slot))
        .map(|kept| (kept.slot.name().to_owned(), walk.slots.get(kept.slot).to_owned()))
        .collect();
    state.written = spec.kept.iter().filter(|kept| walk.written.contains(&kept.slot)).map(|kept| kept.slot.name().to_owned()).collect();
    match walk.decode_error {
        Some(line) => Err(Error::Decode { line }),
        None => Ok(walk.out),
    }
}
