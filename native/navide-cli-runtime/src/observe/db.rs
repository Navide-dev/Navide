//! The SQLite backend: one database for every session, read through one
//! connection per call. Usage follows a row-id watermark (plain or anchored),
//! per-key counters or per-partition watermarks; activity follows one or more
//! row-id watermarks (with held and settling rows) or one watermark per
//! partition.
use super::activity::{At, Walk};
use super::sqlite::{Db, Param, Row};
use super::{bag, file, usage, ActivityState, Backend, Error, File, Memo, UsageRead};
use crate::decl::{Anchored, FirstSight, Page, Partition, Pred, RowWalk, Shrink, SqlUsage, SqlWalk, SqliteRecords, Unreadable, UsageRule, Vendor};
use crate::expr::{self, py_int, py_int_raw, py_str, py_str_opt, Scope, Slots};
use serde_json::{Map, Value};
use std::cell::Cell;
use std::collections::{BTreeSet, HashMap, HashSet};

/// One database for every session.
#[derive(Debug)]
pub struct Sqlite;

/// The call's connection, remembering whether a read it needed failed.
struct Conn {
    db: Option<Db>,
    failed: Cell<bool>,
}

impl Conn {
    fn open<V: Vendor<Backend = Sqlite>>(file: &File<'_, V>) -> Result<Conn, Error> {
        let spec = file.records();
        Ok(Conn { db: Db::open(file.path, spec.json, spec.binary, spec.requires)?, failed: Cell::new(false) })
    }

    /// The rows of `sql`; `None`: not readable this cycle.
    fn rows(&self, sql: &str, params: &[Param]) -> Option<Vec<Row>> {
        let rows = self.optional(sql, params);
        if rows.is_none() {
            self.failed.set(true);
        }
        rows
    }

    /// The same for a query that may fail by design (a table some builds lack).
    fn optional(&self, sql: &str, params: &[Param]) -> Option<Vec<Row>> {
        self.db.as_ref()?.rows(sql, params)
    }

    /// The text a `StoreSeed` is evaluated over: the query's cells joined,
    /// or the database file's own bytes when the query fails (a live store
    /// mid-write), invalid UTF-8 dropped either way.
    fn seed_text(&self, path: &std::path::Path, sql: &str) -> String {
        self.db
            .as_ref()
            .and_then(|db| db.joined(sql))
            .or_else(|| std::fs::read(path).ok().map(|bytes| crate::text::ignore_invalid(&bytes)))
            .unwrap_or_default()
    }

    /// The first column of the first row, as main's `_int` reads it; `None`
    /// when it is SQL `NULL` (`MAX` over no rows) or the query fails.
    fn scalar(&self, sql: &str) -> Option<i64> {
        let rows = self.rows(sql, &[])?;
        let first = rows.first().and_then(|row| row.value.as_object()).and_then(|row| row.values().next().cloned());
        first.filter(|v| !v.is_null()).map(|v| py_int_raw(&v).unwrap_or(0))
    }

    /// A read that failed is the caller's reader's to report, where the
    /// declaration says so.
    fn checked<V: Vendor<Backend = Sqlite>, T>(&self, file: &File<'_, V>, done: T) -> Result<T, Error> {
        // A JSON cell this parser rejects read as nothing: whether Python
        // reads it is Python's to say, so nothing of this read is kept.
        if self.db.as_ref().is_some_and(Db::unparsed) {
            return Err(Error::unparsed("a JSON cell"));
        }
        // Read with `immutable=1`, and a writer has come since: the rows may
        // be behind its -wal, so main's read could differ.
        if self.db.as_ref().is_some_and(Db::wal_appeared) {
            return Err(Error::PythonReads("a -wal file appeared beside a database read immutable".to_owned()));
        }
        if self.failed.get() && file.records().unreadable == Unreadable::Unsupported {
            return Err(Error::Unsupported(format!("{} could not be read", file.path.display())));
        }
        Ok(done)
    }
}

/// A database file's slots before any row. The only slot source that can hand
/// a call over (a header line of JSON text) reads lines of a transcript, which
/// a database does not have, so this never errs; if a declaration ever did
/// ask for one, an empty slot is what a header that cannot be read gives.
fn db_slots<V: Vendor>(file: &File<'_, V>) -> Slots<V> {
    file.slots(&[]).unwrap_or_default()
}

fn row_scope<'a, V: Vendor>(row: &'a Row, slots: &'a Slots<V>) -> Scope<'a, V> {
    Scope { blobs: &row.blobs, ..Scope::of(&row.value, slots) }
}

fn holds<V: Vendor>(when: &Option<Pred<V>>, row: &Row) -> bool {
    when.as_ref().is_some_and(|p| expr::pred(p, &row_scope(row, &Slots::default())))
}

fn id_of(row: &Row, column: &str) -> i64 {
    row.value.get(column).and_then(py_int_raw).unwrap_or(0)
}

impl<V: Vendor<Backend = Sqlite>> Backend<V> for Sqlite {
    type Spec = SqliteRecords<V>;

    fn usage(file: &File<'_, V>, checkpoint: &Map<String, Value>, full: bool, memo: &mut Memo) -> Result<UsageRead, Error> {
        match &file.records().usage {
            SqlUsage::None => Ok(UsageRead::unchanged(checkpoint)),
            SqlUsage::Legacy => Ok(UsageRead { events: Vec::new(), checkpoint: usage::legacy(usage::legacy_seen(checkpoint)) }),
            spec => {
                let Ok(meta) = std::fs::metadata(file.path) else { return Ok(UsageRead::unchanged(checkpoint)) };
                let conn = Conn::open(file)?;
                conn.checked(file, read_usage(file, &conn, spec, &file::identity(&meta), checkpoint, full, memo))
            }
        }
    }

    fn has_usage(spec: &Self::Spec) -> bool {
        !matches!(spec.usage, SqlUsage::None | SqlUsage::Legacy)
    }

    fn usage_rules(spec: &'static Self::Spec) -> Vec<&'static UsageRule<V>> {
        fn of<V: Vendor>(usage: &'static SqlUsage<V>) -> Vec<&'static UsageRule<V>> {
            match usage {
                SqlUsage::None | SqlUsage::Legacy => Vec::new(),
                SqlUsage::After { rules, .. } | SqlUsage::Counters { rules, .. } | SqlUsage::Watermarks { rules, .. } => rules.iter().collect(),
                SqlUsage::Anchored(anchored) => anchored.rules.iter().collect(),
                SqlUsage::OneOf { of: variants, .. } => variants.iter().flat_map(of).collect(),
            }
        }
        of(&spec.usage)
    }

    fn walk(walk: &mut Walk<'_, V>, state: &mut ActivityState, memo: &mut Memo) -> Result<(), Error> {
        let conn = Conn::open(walk.file)?;
        for seed in walk.file.records().seeds {
            let record = serde_json::json!({ "text": conn.seed_text(walk.file.path, seed.sql) });
            let value = expr::text(&seed.value, &Scope::of(&record, &walk.slots));
            walk.slots.set(seed.slot, value);
        }
        walk.restore(state);
        run_walk(walk, &conn, &walk.file.records().activity, state, memo);
        conn.checked(walk.file, ())
    }

    fn load(spec: &'static Self::Spec, bag: &[String], state: &mut ActivityState) {
        load_walk(&spec.activity, bag, state);
    }

    fn store(spec: &'static Self::Spec, state: &ActivityState, bag: &mut Vec<String>) {
        store_walk(&spec.activity, state, bag);
    }
}

/// The variant the vendor's probe picks, its finding left for the caller's
/// reader. `None`: no variant fits the store (or it cannot be read).
fn probed<V: Vendor>(conn: &Conn, probe: V::Ext, memo: &mut Memo) -> Option<usize> {
    let found = V::probe(probe, &mut |sql| Some(conn.rows(sql, &[])?.into_iter().map(|row| row.value).collect()));
    memo.reads.extend(found.read);
    found.pick
}

fn read_usage<V: Vendor<Backend = Sqlite>>(
    file: &File<'_, V>,
    conn: &Conn,
    spec: &'static SqlUsage<V>,
    identity: &str,
    checkpoint: &Map<String, Value>,
    full: bool,
    memo: &mut Memo,
) -> UsageRead {
    match spec {
        SqlUsage::None => UsageRead::unchanged(checkpoint),
        SqlUsage::Legacy => UsageRead { events: Vec::new(), checkpoint: usage::legacy(usage::legacy_seen(checkpoint)) },
        SqlUsage::After { rules, sql, id } => after(file, conn, rules, (sql, id), identity, checkpoint, full),
        SqlUsage::Anchored(anchored) => anchored.read(file, conn, identity, checkpoint, full),
        SqlUsage::Counters { rules, sql, id, kind, map, columns } => counters(file, conn, rules, (sql, id), (kind, map, columns), checkpoint, full),
        SqlUsage::Watermarks { rules, page, part, kind, map } => watermarks(file, conn, rules, (page, part), (kind, map), checkpoint, full, memo),
        SqlUsage::OneOf { probe, of } => match probed::<V>(conn, *probe, memo).and_then(|pick| of.get(pick)) {
            Some(spec) => read_usage(file, conn, spec, identity, checkpoint, full, memo),
            None => UsageRead::unchanged(checkpoint),
        },
    }
}

fn run_walk<V: Vendor<Backend = Sqlite>>(walk: &mut Walk<'_, V>, conn: &Conn, spec: &'static SqlWalk<V>, state: &mut ActivityState, memo: &mut Memo) {
    match spec {
        SqlWalk::OneOf { probe, of } => {
            if let Some(spec) = probed::<V>(conn, *probe, memo).and_then(|pick| of.get(pick)) {
                run_walk(walk, conn, spec, state, memo);
            }
        }
        SqlWalk::Rows(query) => walk_rows(walk, conn, query, &mut state.rows, &mut state.pending),
        SqlWalk::Tables(tables) => {
            for query in *tables {
                let mut mark = state.marks.get(query.key).copied();
                walk_rows(walk, conn, query, &mut mark, &mut state.pending);
                if let Some(mark) = mark {
                    state.marks.insert(query.key.to_owned(), mark);
                }
            }
        }
        SqlWalk::Partitions { page, part, restart_below, .. } => walk_partitions(walk, conn, (page, part), *restart_below, state, memo),
    }
}

fn load_walk<V: Vendor>(spec: &'static SqlWalk<V>, bag: &[String], state: &mut ActivityState) {
    // main's `_int(prev)`: a key that is there but not a number is 0.
    // (`-1` is "from the first row".)
    let mark = |key: &str| bag::find(bag, key).map(|raw| py_int_raw(&Value::String(raw.to_owned())));
    match spec {
        // Every variant's marks: which one the store holds is known per pass.
        SqlWalk::OneOf { of, .. } => of.iter().for_each(|spec| load_walk(spec, bag, state)),
        SqlWalk::Rows(query) => {
            state.rows = mark(query.key).map(|id| id.unwrap_or(0));
            if let Some(revisit) = &query.revisit {
                state.pending = bag::find(bag, revisit.key).and_then(|raw| serde_json::from_str(raw).ok()).unwrap_or_default();
            }
        }
        SqlWalk::Tables(tables) => {
            // A mark that is not a number is a table not walked yet.
            for query in *tables {
                if let Some(Some(id)) = mark(query.key) {
                    state.marks.insert(query.key.to_owned(), id);
                }
            }
        }
        SqlWalk::Partitions { key, anchor, .. } => {
            state.marks = bag::marks(bag, key);
            state.anchored = bag.iter().any(|k| k == anchor);
        }
    }
}

fn store_walk<V: Vendor>(spec: &'static SqlWalk<V>, state: &ActivityState, bag: &mut Vec<String>) {
    match spec {
        SqlWalk::OneOf { of, .. } => of.iter().for_each(|spec| store_walk(spec, state, bag)),
        SqlWalk::Rows(query) => {
            if let Some(revisit) = &query.revisit {
                // `json.dumps(sorted(ids))`.
                let ids: Vec<String> = state.pending.iter().map(i64::to_string).collect();
                bag::replace(bag, revisit.key, (!ids.is_empty()).then(|| format!("[{}]", ids.join(", "))));
            }
            if let Some(id) = state.rows {
                bag::replace(bag, query.key, Some(id.to_string()));
            }
        }
        SqlWalk::Tables(tables) => {
            for query in *tables {
                if let Some(id) = state.marks.get(query.key) {
                    bag::replace(bag, query.key, Some(id.to_string()));
                }
            }
        }
        SqlWalk::Partitions { key, anchor, .. } => {
            // Only the marks that moved are rewritten, as main remembers them.
            let before = bag::marks(bag, key);
            for (part, id) in &state.marks {
                if before.get(part) != Some(id) {
                    bag::replace(bag, &format!("{key}{part}::"), Some(id.to_string()));
                }
            }
            if state.anchored && !bag.iter().any(|k| k == anchor) {
                bag.push((*anchor).to_owned());
            }
        }
    }
}

fn sqlite_cursor(row_id: i64, identity: &str) -> Map<String, Value> {
    let mut cp = Map::new();
    cp.insert("kind".into(), "sqlite".into());
    cp.insert("row_id".into(), row_id.into());
    cp.insert("identity".into(), identity.into());
    cp
}

/// Usage rows after a row-id watermark. The watermark follows the rows that
/// gave an event (main advances it per event, so an all-zero row is read
/// again next cycle); a replaced database starts over. `full`: every row,
/// deduplicated by key (main's `parse_session_file`).
fn after<V: Vendor<Backend = Sqlite>>(
    file: &File<'_, V>,
    conn: &Conn,
    rules: &'static [UsageRule<V>],
    (sql, id): (&str, &str),
    identity: &str,
    checkpoint: &Map<String, Value>,
    full: bool,
) -> UsageRead {
    let prior = py_str_opt(checkpoint.get("identity"));
    let replaced = !prior.is_empty() && prior != identity;
    let mut last = if replaced || full { 0 } else { py_int(checkpoint.get("row_id")) };
    let mut slots = db_slots(file);
    let mut events = Vec::new();
    let mut seen = HashSet::new();
    let rows = conn.rows(sql, &[Param::Int(last)]).unwrap_or_default();
    for row in &rows {
        let at = At::row(&row.blobs);
        let Some(reading) = usage::apply_rules(file, rules, &row.value, at, &mut slots) else { continue };
        let s = usage::scope(&row.value, at, &slots);
        let Some((input, output)) = usage::counts(reading, &s) else { continue };
        if input == 0 && output == 0 {
            continue;
        }
        let key = expr::text(&reading.key, &s);
        if full && !seen.insert(key.clone()) {
            continue;
        }
        last = last.max(py_int(row.value.get(id)));
        events.push(usage::event(file, reading, &s, (input, output), key, sqlite_cursor(last, identity)));
    }
    UsageRead { events, checkpoint: sqlite_cursor(last, identity) }
}

/// Python `str(v)` of a cell: `None`, an integer's digits, the text itself.
fn python_str(value: &Value) -> String {
    match value {
        Value::Null => "None".to_owned(),
        Value::Bool(b) => if *b { "True" } else { "False" }.to_owned(),
        Value::String(s) => s.clone(),
        Value::Number(n) => match (n.as_i64(), n.as_f64()) {
            (Some(i), _) => i.to_string(),
            (None, Some(f)) if f.fract() == 0.0 && f.abs() < 1e16 => format!("{f:.1}"),
            _ => n.to_string(),
        },
        other => other.to_string(),
    }
}

impl<V: Vendor<Backend = Sqlite>> Anchored<V> {
    /// The fingerprint of one row: its anchor columns' `str()`, joined by `|`.
    fn fingerprint(&self, row: &Row) -> String {
        self.anchor.iter().map(|column| python_str(row.value.get(*column).unwrap_or(&Value::Null))).collect::<Vec<_>>().join("|")
    }

    fn fingerprint_at(&self, conn: &Conn, row_id: i64) -> Option<String> {
        Some(self.fingerprint(conn.rows(self.anchor_sql, &[Param::Int(row_id)])?.first()?))
    }

    /// main's cursor: `{"kind": "sqlite", "row_id", ["pending",] "identity", "anchor"[, tag]}`.
    fn cursor(&self, row_id: i64, anchor: &str, pending: &BTreeSet<i64>, identity: &str) -> Map<String, Value> {
        let mut cp = sqlite_cursor(row_id, identity);
        if let Some(settling) = &self.settling {
            let kept: Vec<i64> = pending.iter().rev().take(settling.cap).rev().copied().collect();
            cp.insert("pending".into(), kept.into());
        }
        cp.insert("anchor".into(), anchor.into());
        if let Some((key, value)) = self.tag {
            cp.insert(key.into(), value.into());
        }
        cp
    }

    fn read(&'static self, file: &File<'_, V>, conn: &Conn, identity: &str, checkpoint: &Map<String, Value>, full: bool) -> UsageRead {
        let prior = py_str_opt(checkpoint.get("identity"));
        let fresh = full || (!prior.is_empty() && prior != identity);
        let mut last = if fresh { 0 } else { py_int(checkpoint.get("row_id")) };
        let mut anchor = if fresh { String::new() } else { py_str_opt(checkpoint.get("anchor")) };
        let mut pending: BTreeSet<i64> = match checkpoint.get("pending") {
            Some(Value::Array(ids)) if !fresh && self.settling.is_some() => ids.iter().filter_map(py_int_raw).filter(|id| *id > 0).collect(),
            _ => BTreeSet::new(),
        };
        if let Some((key, value)) = self.tag {
            if last != 0 && checkpoint.get(key).and_then(Value::as_str) != Some(value) {
                // A mark taken on another table, whose rows were copied into
                // this one: start from the newest row, crediting no copy.
                let Some(top) = conn.scalar(self.newest) else { return UsageRead::unchanged(checkpoint) };
                last = top;
                pending.clear();
                anchor = self.fingerprint_at(conn, last).unwrap_or_default();
            }
        }
        if last != 0 && !anchor.is_empty() && self.fingerprint_at(conn, last).is_some_and(|now| now != anchor) {
            // Another row stands under the watermark id: it was never
            // credited. Start just below it; never rescan.
            last -= 1;
            anchor.clear();
            pending.clear();
        }
        // `full`: every row, whatever its id.
        let settling_ids = serde_json::to_string(&pending).unwrap_or_default();
        let params = [Param::Int(if full { i64::MIN } else { last }), Param::Text(&settling_ids)];
        let Some(mut rows) = conn.rows(self.sql, &params[..if self.settling.is_some() { 2 } else { 1 }]) else {
            return UsageRead::unchanged(checkpoint);
        };
        if rows.is_empty() && last != 0 {
            if let Some(top) = conn.scalar(self.newest).filter(|top| *top < last) {
                // The watermark is above every id (the store was rebuilt):
                // everything at or below the new top was credited under the
                // old numbering, so re-anchor there.
                last = top;
                pending.clear();
                anchor = self.fingerprint_at(conn, last).unwrap_or_default();
            }
        }
        if let (Some(lookup), false) = (&self.lookup, rows.is_empty()) {
            // `{str(key): str(value or "")}` of the rows with a truthy key.
            let found: HashMap<String, String> = conn
                .optional(lookup.sql, &[])
                .unwrap_or_default()
                .iter()
                .filter_map(|row| Some((row.value.get("key").filter(|key| expr::truthy(key)).map(py_str)?, py_str_opt(row.value.get("value")))))
                .collect();
            for row in &mut rows {
                let value = found.get(&py_str_opt(row.value.get(lookup.by))).cloned().unwrap_or_default();
                if let Value::Object(object) = &mut row.value {
                    object.insert(lookup.column.to_owned(), value.into());
                }
            }
        }
        let mut slots = db_slots(file);
        let (mut events, mut seen) = (Vec::new(), HashSet::new());
        let mut next = last;
        for row in &rows {
            let id = id_of(row, self.id);
            if id > next {
                next = id;
                anchor = self.fingerprint(row);
            }
            if let Some(settling) = &self.settling {
                if expr::pred(&settling.when, &row_scope(row, &slots)) {
                    pending.insert(id);
                    continue;
                }
                pending.remove(&id);
            }
            let at = At::row(&row.blobs);
            let Some(reading) = usage::apply_rules(file, self.rules, &row.value, at, &mut slots) else { continue };
            let s = usage::scope(&row.value, at, &slots);
            let Some((input, output)) = usage::counts(reading, &s) else { continue };
            if input == 0 && output == 0 {
                continue;
            }
            let key = expr::text(&reading.key, &s);
            if full && !seen.insert(key.clone()) {
                continue;
            }
            let at_row = if full { Map::new() } else { self.cursor(next, &anchor, &pending, identity) };
            events.push(usage::event(file, reading, &s, (input, output), key, at_row));
        }
        UsageRead { events, checkpoint: self.cursor(next, &anchor, &pending, identity) }
    }
}

fn counters<V: Vendor<Backend = Sqlite>>(
    file: &File<'_, V>,
    conn: &Conn,
    rules: &'static [UsageRule<V>],
    (sql, id): (&str, &str),
    (kind, map, columns): (&str, &str, &[&str]),
    checkpoint: &Map<String, Value>,
    full: bool,
) -> UsageRead {
    let Some(rows) = conn.rows(sql, &[]) else { return UsageRead::unchanged(checkpoint) };
    let empty = Map::new();
    let last = match checkpoint.get(map) {
        Some(Value::Object(last)) if !full && checkpoint.get("kind").and_then(Value::as_str) == Some(kind) => last,
        _ => &empty,
    };
    // `int(v or 0)`.
    let int = |v: Option<&Value>| v.filter(|v| expr::truthy(v)).and_then(py_int_raw).unwrap_or(0);
    let mut slots = db_slots(file);
    let (mut events, mut state, mut seen) = (Vec::new(), Map::new(), HashSet::new());
    for mut row in rows {
        let key = py_str_opt(row.value.get(id));
        let now: Vec<i64> = columns.iter().map(|c| int(row.value.get(*c))).collect();
        let base: Vec<i64> = match last.get(&key) {
            Some(Value::Array(prev)) if prev.len() == columns.len() => prev.iter().map(|v| py_int_raw(v).unwrap_or(0)).collect(),
            _ => vec![0; columns.len()],
        };
        let delta: Map<String, Value> = columns.iter().zip(now.iter().zip(&base)).map(|(c, (n, b))| ((*c).to_owned(), (n - b).max(0).into())).collect();
        let grew = delta.values().any(|d| d.as_i64() != Some(0));
        let joined = now.iter().map(i64::to_string).collect::<Vec<_>>().join(":");
        state.insert(key, now.into());
        if let Value::Object(object) = &mut row.value {
            object.insert("delta".into(), delta.into());
            object.insert("counters".into(), joined.into());
        }
        if !grew {
            continue;
        }
        let at = At::row(&row.blobs);
        let Some(reading) = usage::apply_rules(file, rules, &row.value, at, &mut slots) else { continue };
        let s = usage::scope(&row.value, at, &slots);
        let Some(read) = usage::counts(reading, &s) else { continue };
        let dedup = expr::text(&reading.key, &s);
        if full && !seen.insert(dedup.clone()) {
            continue;
        }
        events.push(usage::event(file, reading, &s, read, dedup, Map::new()));
    }
    let mut next = Map::new();
    next.insert("kind".into(), kind.into());
    next.insert(map.into(), state.into());
    UsageRead { events, checkpoint: next }
}

/// Per-partition watermarks: every partition whose newest id is above its
/// mark is read from the mark on, and each row read moves the mark (with or
/// without a reading). Any unreadable query leaves the checkpoint as it was.
#[allow(clippy::too_many_arguments)]
fn watermarks<V: Vendor<Backend = Sqlite>>(
    file: &File<'_, V>,
    conn: &Conn,
    rules: &'static [UsageRule<V>],
    (query, part): (&Page<V>, &Partition<V>),
    (kind, map): (&str, &str),
    checkpoint: &Map<String, Value>,
    full: bool,
    memo: &mut Memo,
) -> UsageRead {
    let mut marks: Map<String, Value> = match checkpoint.get(map) {
        Some(Value::Object(last)) if !full && checkpoint.get("kind").and_then(Value::as_str) == Some(kind) => {
            last.iter().filter(|(_, v)| v.is_i64()).map(|(k, v)| (k.clone(), v.clone())).collect()
        }
        _ => Map::new(),
    };
    let Some(tops) = tops(conn, part) else { return UsageRead::unchanged(checkpoint) };
    let mut slots = db_slots(file);
    let (mut events, mut seen) = (Vec::new(), HashSet::new());
    for (name, top) in tops {
        let after = marks.get(&name).and_then(Value::as_i64).unwrap_or(-1);
        if top <= after {
            continue;
        }
        let Some(rows) = page(conn, file, query, part, &name, after, memo) else { return UsageRead::unchanged(checkpoint) };
        for row in &rows {
            marks.insert(name.clone(), id_of(row, query.id).into());
            let at = At::row(&row.blobs);
            let Some(reading) = usage::apply_rules(file, rules, &row.value, at, &mut slots) else { continue };
            let s = usage::scope(&row.value, at, &slots);
            let Some(read) = usage::counts(reading, &s) else { continue };
            let key = expr::text(&reading.key, &s);
            if full && !seen.insert(key.clone()) {
                continue;
            }
            events.push(usage::event(file, reading, &s, read, key, Map::new()));
        }
    }
    let mut next = Map::new();
    next.insert("kind".into(), kind.into());
    next.insert(map.into(), marks.into());
    UsageRead { events, checkpoint: next }
}

/// Every partition with its newest id, in the query's order (main iterates
/// its `GROUP BY` result); rows without either are skipped.
fn tops<V: Vendor>(conn: &Conn, part: &Partition<V>) -> Option<Vec<(String, i64)>> {
    let rows = conn.rows(part.tops, &[])?;
    Some(
        rows.iter()
            .filter_map(|row| {
                let name = row.value.get("part").filter(|v| !v.is_null())?;
                let top = row.value.get("top").and_then(py_int_raw)?;
                Some((py_str(name), top))
            })
            .collect(),
    )
}

/// The partition's label: remembered once resolved; else looked up, and a
/// partition no query labels keeps its own name (and is reported).
fn label<V: Vendor>(conn: &Conn, file: &File<'_, V>, part: &Partition<V>, name: &str, memo: &mut Memo) -> String {
    let key = (file.path.to_owned(), name.to_owned());
    if let Some(found) = memo.labels.get(&key) {
        return found.clone();
    }
    let slots = Slots::<V>::default();
    for (sql, text) in part.label {
        let Some(rows) = conn.optional(sql, &[Param::Text(name)]) else { continue };
        let Some(first) = rows.first() else { continue };
        let value = expr::text(text, &row_scope(first, &slots));
        if !value.is_empty() {
            memo.labels.insert(key, value.clone());
            return value;
        }
    }
    memo.note(part.unlabelled, part.unlabelled.replace("{path}", &file.path_text()).replace("{part}", name));
    name.to_owned()
}

/// One page of a partition's rows after `after`, a held last row dropped and
/// every row labelled. `None`: not readable this cycle.
fn page<V: Vendor>(conn: &Conn, file: &File<'_, V>, query: &Page<V>, part: &Partition<V>, name: &str, after: i64, memo: &mut Memo) -> Option<Vec<Row>> {
    let label = label(conn, file, part, name, memo);
    let mut rows = conn.rows(query.sql, &[Param::Text(name), Param::Int(after), Param::Int(query.size)])?;
    if rows.last().is_some_and(|row| holds(&query.hold_last, row)) {
        rows.pop();
    }
    for row in &mut rows {
        if let Value::Object(object) = &mut row.value {
            object.insert(part.label_as.to_owned(), label.clone().into());
        }
    }
    Some(rows)
}

/// Rows after one watermark (`mark`; `None` until the table is first walked).
fn walk_rows<V: Vendor>(walk: &mut Walk<'_, V>, conn: &Conn, query: &RowWalk<V>, mark: &mut Option<i64>, pending: &mut BTreeSet<i64>) {
    let after = match (*mark, query.first_sight) {
        (Some(after), _) => after,
        (None, FirstSight::Start) => 0,
        (None, FirstSight::Newest) => {
            // Everything already in the database is history.
            *mark = conn.scalar(query.newest);
            return;
        }
    };
    let after = match query.shrink {
        Shrink::Ignore => after,
        Shrink::ToNewest => match conn.scalar(query.newest) {
            None => return,
            Some(top) if top < after => {
                *mark = Some(top);
                return;
            }
            Some(_) => after,
        },
        Shrink::ToStart => {
            let after = after.max(0);
            if after > 0 && conn.scalar(query.newest).is_some_and(|top| top < after) { 0 } else { after }
        }
    };
    let settling = serde_json::to_string(pending).unwrap_or_default();
    let params = [Param::Int(after), Param::Int(query.page), Param::Text(&settling)];
    let params = if query.revisit.is_some() { &params[..] } else { &params[..2] };
    let Some(mut rows) = conn.rows(query.sql, params) else { return };
    if rows.last().is_some_and(|row| holds(&query.hold_last, row)) {
        rows.pop();
    }
    let newest = rows.last().map_or(after, |last| after.max(id_of(last, query.id)));
    *mark = Some(newest);
    for row in &mut rows {
        let at = id_of(row, query.id);
        if let Some(revisit) = &query.revisit {
            if expr::pred(&revisit.when, &row_scope(row, &Slots::default())) {
                // Still settling: reported once, then quiet until it settles.
                if !pending.insert(at) {
                    continue;
                }
            } else {
                pending.remove(&at);
            }
        }
        if let (Some(column), Value::Object(object)) = (query.last_as, &mut row.value) {
            object.insert(column.to_owned(), (at == newest).into());
        }
        walk.record(&row.value, At::row(&row.blobs));
    }
}

/// Rows after each partition's watermark. First sight anchors every
/// partition then present at its newest id; one that appears later is read
/// from its start.
fn walk_partitions<V: Vendor>(
    walk: &mut Walk<'_, V>,
    conn: &Conn,
    (query, part): (&Page<V>, &Partition<V>),
    restart_below: bool,
    state: &mut ActivityState,
    memo: &mut Memo,
) {
    let Some(tops) = tops(conn, part) else { return };
    if !state.anchored {
        state.marks.extend(tops);
        state.anchored = true;
        return;
    }
    for (name, top) in tops {
        let after = state.marks.get(&name).copied().unwrap_or(-1);
        if top < after && restart_below {
            state.marks.insert(name, top);
            continue;
        }
        if top <= after {
            continue;
        }
        for row in page(conn, walk.file, query, part, &name, after, memo).unwrap_or_default() {
            state.marks.insert(name.clone(), id_of(&row, query.id));
            walk.record(&row.value, At::row(&row.blobs));
        }
    }
}
