//! Token usage in main's checkpoint shapes: what every backend shares (the
//! rules, the event, the legacy seen-set) and the three file modes — one
//! event per usage record (deduplicated through a bounded key window), one
//! event per read carrying the delta of running totals, and the totals of a
//! sidecar document.
use super::activity::{self, At};
use super::file::Tail;
use super::{Error, File, UsageEvent, UsageRead};
use crate::decl::{FileMode, FileUsage, RawValue, Reading, Restore, SlotKey, UsageRule, Vendor};
use crate::expr::{self, py_int, py_str_opt, Scope, Slots};
use crate::pyjson::{self, Parsed};
use serde_json::{Map, Value};
use std::collections::{BTreeSet, HashSet, VecDeque};

pub(crate) fn scope<'a, V: Vendor>(record: &'a Value, at: At<'a>, slots: &'a Slots<V>) -> Scope<'a, V> {
    Scope { offset: at.end, blobs: at.blobs, ..Scope::of(record, slots) }
}

/// The first rule whose `when` holds: its slot effects run, and its reading
/// (when it has one) is returned.
pub(crate) fn apply_rules<V: Vendor>(
    file: &File<'_, V>,
    rules: &'static [UsageRule<V>],
    record: &Value,
    at: At<'_>,
    slots: &mut Slots<V>,
) -> Option<&'static Reading<V>> {
    let rule = rules.iter().find(|r| expr::pred(&r.when, &scope(record, at, slots)))?;
    super::trace::matched(rule);
    if !rule.effects.is_empty() {
        activity::slot_effects(file, rule.effects, record, at, slots);
    }
    rule.reading.as_ref()
}

fn raw_map<V: Vendor>(reading: &Reading<V>, s: &Scope<V>) -> Map<String, Value> {
    let mut raw = Map::new();
    for (path, value) in reading.raw {
        let value: Value = match value {
            RawValue::Num(n) => expr::num(n, s).unwrap_or(0).into(),
            RawValue::Text(t) => expr::text(t, s).into(),
        };
        let Some((last, parents)) = path.split_last() else { continue };
        let mut node = &mut raw;
        for key in parents {
            let child = node.entry(key.to_string()).or_insert_with(|| Value::Object(Map::new()));
            if !child.is_object() {
                // A shorter path already put a value here: the nested one wins.
                *child = Value::Object(Map::new());
            }
            node = child.as_object_mut().expect("just made an object");
        }
        node.insert(last.to_string(), value);
    }
    raw
}

pub(crate) fn event<V: Vendor>(
    file: &File<'_, V>,
    reading: &Reading<V>,
    s: &Scope<V>,
    (input, output): (i64, i64),
    key: String,
    checkpoint: Map<String, Value>,
) -> UsageEvent {
    UsageEvent {
        vendor: file.vendor().to_owned(),
        input_tokens: input,
        output_tokens: output,
        cwd: expr::text(&reading.cwd, s),
        session_id: expr::text(&reading.session_id, s),
        file_path: file.path_text(),
        dedup_key: key,
        timestamp: expr::text(&reading.timestamp, s),
        model: expr::text(&reading.model, s),
        checkpoint,
        raw: raw_map(reading, s),
        cache_read_tokens: expr::num(&reading.cache_read, s).unwrap_or(0),
        cache_creation_tokens: expr::num(&reading.cache_creation, s).unwrap_or(0),
        cli_version: expr::text(&reading.cli_version, s),
    }
}

/// The input and output of a reading (`None`: no reading on this record).
pub(crate) fn counts<V: Vendor>(reading: &Reading<V>, s: &Scope<V>) -> Option<(i64, i64)> {
    Some((expr::num(&reading.input, s)?, expr::num(&reading.output, s)?))
}

fn persist_into<V: Vendor>(spec: &FileUsage<V>, slots: &Slots<V>, checkpoint: &mut Map<String, Value>) {
    for slot in spec.persist {
        let value = slots.get(*slot);
        let value = if spec.flags.contains(slot) { Value::Bool(!value.is_empty()) } else { value.into() };
        checkpoint.insert(slot.name().to_owned(), value);
    }
}

/// A file's usage after `checkpoint`; `tail` reads the records past it.
pub(crate) fn from_file<V: Vendor>(
    file: &File<'_, V>,
    spec: &'static FileUsage<V>,
    checkpoint: &Map<String, Value>,
    full: bool,
    tail: impl FnOnce(&Map<String, Value>) -> Result<Tail, Error>,
) -> Result<UsageRead, Error> {
    let mut slots = file.slots(spec.slots)?;
    if let FileMode::Snapshot { suffix, mark } = spec.mode {
        return Ok(snapshot(file, spec, slots, checkpoint, suffix, mark));
    }
    let tail = tail(checkpoint)?;
    let restore = match spec.restore {
        Restore::UnlessRotated => !tail.rotated,
        Restore::UnlessReplaced => !tail.replaced,
    };
    if restore {
        for slot in spec.persist {
            let value = match checkpoint.get(slot.name()) {
                Some(v) if spec.flags.contains(slot) => if expr::truthy(v) { "1".to_owned() } else { String::new() },
                other => py_str_opt(other),
            };
            if !value.is_empty() {
                slots.set(*slot, value);
            }
        }
    }
    match spec.mode {
        FileMode::PerRecord { window, keep_on_rotation, credited } => {
            Ok(per_record(file, spec, slots, checkpoint, tail, Window { size: window, keep_on_rotation, credited: credited && !full }, full))
        }
        FileMode::Cumulative { stamp } => cumulative(file, spec, slots, checkpoint, tail, restore, stamp),
        // Returned above; a sidecar document has no tail.
        FileMode::Snapshot { .. } => Err(Error::Unsupported("a snapshot has no record tail".to_owned())),
    }
}

/// `int()` of each half of a `"<in>:<out>"` mark; (0, 0) when it is not one.
fn mark_totals(value: &str) -> (i64, i64) {
    let parts: Vec<&str> = value.split(':').collect();
    let int = |s: &str| expr::py_int_raw(&Value::String(s.to_owned()));
    match parts.as_slice() {
        [a, b] => match (int(a), int(b)) {
            (Some(a), Some(b)) => (a, b),
            _ => (0, 0),
        },
        _ => (0, 0),
    }
}

/// main's base `parse_incremental` seen-set: `str(k)` of each key.
pub(crate) fn legacy_seen(checkpoint: &Map<String, Value>) -> BTreeSet<String> {
    checkpoint.get("legacy_seen").and_then(Value::as_array).map(|keys| keys.iter().map(python_str).collect()).unwrap_or_default()
}

pub(crate) fn legacy(seen: BTreeSet<String>) -> Map<String, Value> {
    let mut next = Map::new();
    next.insert("kind".into(), "legacy".into());
    next.insert("legacy_seen".into(), seen.into_iter().collect::<Vec<_>>().into());
    next
}

fn snapshot<V: Vendor>(file: &File<'_, V>, spec: &'static FileUsage<V>, mut slots: Slots<V>, checkpoint: &Map<String, Value>, suffix: &str, mark: &str) -> UsageRead {
    let mut seen = legacy_seen(checkpoint);
    let mut events = Vec::new();
    let stem = file.path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let doc = std::fs::read_to_string(file.path.with_file_name(format!("{stem}{suffix}")))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(Value::is_object);
    if let Some(doc) = doc {
        let at = At::line(0, 0);
        if let Some(reading) = apply_rules(file, spec.rules, &doc, at, &mut slots) {
            let s = scope(&doc, at, &slots);
            let totals = (expr::num(&reading.input, &s).unwrap_or(0), expr::num(&reading.output, &s).unwrap_or(0));
            let marked = seen.iter().find_map(|k| k.strip_prefix(mark)).map_or((0, 0), mark_totals);
            let delta = (totals.0 - marked.0, totals.1 - marked.1);
            let set_mark = |seen: &mut BTreeSet<String>| {
                seen.retain(|k| !k.starts_with(mark));
                seen.insert(format!("{mark}{}:{}", totals.0, totals.1));
            };
            if delta.0 < 0 || delta.1 < 0 {
                set_mark(&mut seen);
            } else if delta.0 != 0 || delta.1 != 0 {
                let s = Scope { totals, ..s };
                let key = expr::text(&reading.key, &s);
                if seen.insert(key.clone()) {
                    set_mark(&mut seen);
                    events.push(event(file, reading, &s, delta, key, Map::new()));
                }
            }
        }
    }
    UsageRead { events, checkpoint: legacy(seen) }
}

struct Window {
    size: usize,
    keep_on_rotation: bool,
    credited: bool,
}

fn per_record<V: Vendor>(
    file: &File<'_, V>,
    spec: &'static FileUsage<V>,
    mut slots: Slots<V>,
    checkpoint: &Map<String, Value>,
    tail: Tail,
    window: Window,
    full: bool,
) -> UsageRead {
    let Window { size, keep_on_rotation, credited } = window;
    let mut recent: VecDeque<String> = if tail.rotated && !keep_on_rotation {
        VecDeque::new()
    } else {
        let kept: Vec<String> = checkpoint
            .get("recent_keys")
            .and_then(Value::as_array)
            .map(|keys| keys.iter().map(python_str).collect())
            .unwrap_or_default();
        kept[kept.len().saturating_sub(size)..].iter().cloned().collect()
    };
    let mut all_seen: HashSet<String> = HashSet::new();
    let prior_raw = checkpoint.get("credited_count").filter(|v| !v.is_null());
    let prior = py_int(prior_raw);
    let mut skip_remaining = if tail.rotated { prior } else { 0 };
    let mut credited_count = if tail.rotated { 0 } else { prior };
    let legacy_reread = tail.rotated && prior_raw.is_none();
    let mut events = Vec::new();
    let remember = |recent: &mut VecDeque<String>, key: &str| {
        recent.push_back(key.to_owned());
        while recent.len() > size {
            recent.pop_front();
        }
    };
    // What every event's checkpoint starts from. The window the previous
    // checkpoint carried is each event's own below, so it is not copied once
    // per event just to be replaced.
    let mut base = tail.checkpoint.clone();
    if size > 0 {
        base.shift_remove("recent_keys");
    }
    for (end, record) in &tail.records {
        let Some(record) = record else { continue };
        let at = At::line(0, *end);
        let Some(reading) = apply_rules(file, spec.rules, record, at, &mut slots) else { continue };
        let s = scope(record, at, &slots);
        let key = expr::text(&reading.key, &s);
        if (reading.key_required && key.is_empty()) || (!reading.key_invalid.is_empty() && key == reading.key_invalid) {
            continue;
        }
        let Some((input, output)) = counts(reading, &s) else { continue };
        if input == 0 && output == 0 {
            continue;
        }
        if full {
            if !all_seen.insert(key.clone()) {
                continue;
            }
        } else {
            if credited && (legacy_reread || skip_remaining > 0) {
                skip_remaining = (skip_remaining - 1).max(0);
                credited_count += 1;
                remember(&mut recent, &key);
                continue;
            }
            if size > 0 && recent.contains(&key) {
                continue;
            }
            if credited {
                credited_count += 1;
            }
            if size > 0 {
                remember(&mut recent, &key);
            }
        }
        let mut cp = base.clone();
        cp.insert("offset".into(), (*end).into());
        if size > 0 {
            cp.insert("recent_keys".into(), recent.iter().cloned().collect::<Vec<_>>().into());
        }
        persist_into(spec, &slots, &mut cp);
        if credited {
            cp.insert("credited_count".into(), credited_count.into());
        }
        events.push(event(file, reading, &s, (input, output), key, cp));
    }
    let mut next = tail.checkpoint;
    if size > 0 {
        next.insert("recent_keys".into(), recent.into_iter().collect::<Vec<_>>().into());
    }
    persist_into(spec, &slots, &mut next);
    if credited {
        next.insert("credited_count".into(), credited_count.into());
    }
    UsageRead { events, checkpoint: next }
}

/// Python `str(k)` of a JSON value read back from a checkpoint.
fn python_str(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "None".to_owned(),
        other => expr::py_str(other),
    }
}

fn stamped(stamp: &[(&str, i64)], checkpoint: &Map<String, Value>) -> bool {
    stamp.iter().all(|(key, want)| checkpoint.get(*key).and_then(Value::as_f64) == Some(*want as f64))
}

/// The totals of the last totals record wholly before `offset` (a checkpoint
/// written before its stamp existed stored them in an older basis).
fn totals_before<V: Vendor>(file: &File<'_, V>, spec: &'static FileUsage<V>, offset: u64) -> Result<(i64, i64), Error> {
    let Ok(data) = std::fs::read(file.path) else { return Ok((0, 0)) };
    let head = &data[..(offset as usize).min(data.len())];
    let mut found = (0, 0);
    let scratch = Slots::<V>::default();
    for raw in head.split(|b| *b == b'\n' || *b == b'\r') {
        let Ok(text) = std::str::from_utf8(raw) else { continue };
        if text.trim_matches([' ', '\t']).is_empty() {
            continue;
        }
        let record = match pyjson::parse(text) {
            Parsed::Value(record) => record,
            Parsed::Rejected => continue,
            // Python may read a line this parser does not: its totals are not ours to skip.
            Parsed::Python => return Err(Error::unparsed("a record before the checkpoint")),
        };
        let s = scope(&record, At::line(0, 0), &scratch);
        let Some(rule) = spec.rules.iter().find(|r| expr::pred(&r.when, &s)) else { continue };
        if let Some(totals) = rule.reading.as_ref().and_then(|reading| counts(reading, &s)) {
            found = totals;
        }
    }
    Ok(found)
}

fn cumulative<V: Vendor>(
    file: &File<'_, V>,
    spec: &'static FileUsage<V>,
    mut slots: Slots<V>,
    checkpoint: &Map<String, Value>,
    tail: Tail,
    restore: bool,
    stamp: &'static [(&'static str, i64)],
) -> Result<UsageRead, Error> {
    let mut prev = if restore { (py_int(checkpoint.get("input_total")), py_int(checkpoint.get("output_total"))) } else { (0, 0) };
    if prev != (0, 0) && !stamp.is_empty() && !stamped(stamp, checkpoint) {
        prev = totals_before(file, spec, py_int(checkpoint.get("offset")) as u64)?;
    }
    let mut latest_totals = prev;
    let mut latest: Option<(&Value, &'static Reading<V>, u64)> = None;
    for (end, record) in &tail.records {
        let Some(record) = record else { continue };
        let at = At::line(0, *end);
        let Some(reading) = apply_rules(file, spec.rules, record, at, &mut slots) else { continue };
        let Some(totals) = counts(reading, &scope(record, at, &slots)) else { continue };
        latest_totals = totals;
        latest = Some((record, reading, *end));
    }
    let mut next = tail.checkpoint.clone();
    next.insert("input_total".into(), latest_totals.0.into());
    next.insert("output_total".into(), latest_totals.1.into());
    persist_into(spec, &slots, &mut next);
    for (key, value) in stamp {
        next.insert((*key).to_owned(), (*value).into());
    }
    let Some((record, reading, end)) = latest else {
        return Ok(UsageRead { events: Vec::new(), checkpoint: next });
    };
    let delta = (latest_totals.0 - prev.0, latest_totals.1 - prev.1);
    if delta.0 < 0 || delta.1 < 0 || delta == (0, 0) {
        return Ok(UsageRead { events: Vec::new(), checkpoint: next });
    }
    let mut cp = next.clone();
    cp.insert("offset".into(), end.into());
    let s = Scope { totals: latest_totals, ..scope(record, At::line(0, end), &slots) };
    let key = expr::text(&reading.key, &s);
    let event = event(file, reading, &s, delta, key, cp);
    Ok(UsageRead { events: vec![event], checkpoint: next })
}
