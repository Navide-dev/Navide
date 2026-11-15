//! Evaluation of the declaration's record-access language (`Pred`, `Text`,
//! `Num`) over one JSON record. Semantics follow the Python readers exactly
//! where they matter: `str(x or "")`, `max(0, int(x))`, `str.strip()`.
//! Generic over the vendor, so each CLI gets its own compiled evaluator and
//! its `Ext` values are direct calls.
use crate::decl::{Num, Pred, SlotKey, StrTest, Text, Vendor};
use serde_json::Value;
use std::marker::PhantomData;

/// A file's slot values, indexed by the vendor's typed handles.
pub struct Slots<V: Vendor> {
    values: Vec<String>,
    vendor: PhantomData<fn() -> V>,
}

impl<V: Vendor> Default for Slots<V> {
    fn default() -> Self {
        Slots { values: vec![String::new(); V::Slot::ALL.len()], vendor: PhantomData }
    }
}

impl<V: Vendor> Slots<V> {
    pub fn get(&self, slot: V::Slot) -> &str {
        &self.values[slot.index()]
    }

    /// An optional slot (the event's cwd or session id): "" when the CLI has none.
    pub fn of(&self, slot: Option<V::Slot>) -> &str {
        slot.map_or("", |s| self.get(s))
    }

    pub fn set(&mut self, slot: V::Slot, value: String) {
        self.values[slot.index()] = value;
    }

    pub fn is_set(&self, slot: V::Slot) -> bool {
        !self.get(slot).is_empty()
    }
}

/// A binary column of a SQLite row, by column name.
pub type Blob = (String, Vec<u8>);

/// Everything an expression can see: the record, the slots, and the facts
/// of the walk it is in.
pub struct Scope<'a, V: Vendor> {
    pub record: &'a Value,
    /// The row's binary columns (empty for a file record).
    pub blobs: &'a [Blob],
    pub line: usize,
    pub offset: u64,
    pub slots: &'a Slots<V>,
    /// The inferred-turn tracker's turn was cancelled.
    pub cancelled: bool,
    /// The key of the map entry being iterated (turn calls over a map).
    pub entry_key: &'a str,
    /// The walk's clock (seconds since the epoch) and the events it has
    /// emitted so far; 0 outside an activity walk.
    pub now: f64,
    pub emitted: usize,
    /// False only for a line a replay walk already walked.
    pub fresh: bool,
    /// The line walk started past the file's first line.
    pub resumed: bool,
    /// `Text::TotalIn` / `TotalOut`.
    pub totals: (i64, i64),
}

impl<'a, V: Vendor> Scope<'a, V> {
    /// A record seen outside any walk: no clock, no walk facts.
    pub fn of(record: &'a Value, slots: &'a Slots<V>) -> Scope<'a, V> {
        Scope { record, blobs: &[], line: 0, offset: 0, slots, cancelled: false, entry_key: "", now: 0.0, emitted: 0, fresh: true, resumed: false, totals: (0, 0) }
    }

    pub fn with_record<'b>(&'b self, record: &'b Value) -> Scope<'b, V> {
        Scope { record, ..*self }
    }

    /// A binary column's bytes (empty when it is absent or not a BLOB).
    pub fn blob(&self, column: &str) -> &'a [u8] {
        self.blobs.iter().find(|(name, _)| name == column).map_or(&[], |(_, bytes)| bytes)
    }

    pub fn get(&self, path: &[&str]) -> Option<&'a Value> {
        get(self.record, path)
    }
}

pub fn get<'v>(value: &'v Value, path: &[&str]) -> Option<&'v Value> {
    let mut node = value;
    for key in path {
        node = node.as_object()?.get(*key)?;
    }
    Some(node)
}

/// Python truthiness.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// Python `str(value or "")`.
pub fn py_str(value: &Value) -> String {
    if !truthy(value) {
        return String::new();
    }
    match value {
        Value::String(s) => s.clone(),
        Value::Bool(_) => "True".to_owned(),
        Value::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) => i.to_string(),
            (_, Some(u)) => u.to_string(),
            _ => {
                let f = n.as_f64().unwrap_or(0.0);
                if f.fract() == 0.0 && f.abs() < 1e16 { format!("{f:.1}") } else { f.to_string() }
            }
        },
        other => other.to_string(),
    }
}

pub fn py_str_opt(value: Option<&Value>) -> String {
    value.map(py_str).unwrap_or_default()
}

/// Python `int(value)`, `None` where it raises.
pub fn py_int_raw(value: &Value) -> Option<i64> {
    match value {
        Value::Bool(b) => Some(*b as i64),
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_u64().map(|u| u.min(i64::MAX as u64) as i64))
            .or_else(|| n.as_f64().filter(|f| f.is_finite()).map(|f| f.trunc() as i64)),
        Value::String(s) => {
            let t = py_strip(s).replace('_', "");
            let digits = t.strip_prefix(['+', '-']).unwrap_or(&t);
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) || s.contains("__") {
                return None;
            }
            t.parse::<i64>().ok()
        }
        _ => None,
    }
}

/// Python `max(0, int(value))`, 0 where `int` raises.
pub fn py_int(value: Option<&Value>) -> i64 {
    value.and_then(py_int_raw).unwrap_or(0).max(0)
}

/// `usage_common._num`: `float(v)` except bools and None.
pub fn py_float(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => py_strip(s).parse::<f64>().ok(),
        _ => None,
    }
}

/// Python's `str.isspace()` (and `\s`).
pub fn py_space(c: char) -> bool {
    c.is_whitespace() || ('\x1c'..='\x1f').contains(&c)
}

/// Python `str.strip()`.
pub fn py_strip(s: &str) -> &str {
    s.trim_matches(py_space)
}

pub fn cap(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_owned();
    }
    let half = max / 2;
    let head: String = text.chars().take(half).collect();
    let tail: String = text.chars().skip(count - half).collect();
    format!("{head}\n…\n{tail}")
}

pub const USER_PROMPT_MAX_CHARS: usize = 500;

/// `log_readers.base.user_prompt_text`.
pub fn user_prompt(raw: &str) -> String {
    let text = py_strip(raw);
    if text.is_empty() || text.starts_with('<') {
        return String::new();
    }
    text.chars().take(USER_PROMPT_MAX_CHARS).collect()
}

pub const FULL_PROMPT_MAX_CHARS: usize = 16000;

/// The `PromptText.full` of a text that is a `UserPrompt` (possibly chosen
/// through `If` / `FirstOf`); "" for any other text.
pub fn prompt_full<V: Vendor>(t: &Text<V>, s: &Scope<V>) -> String {
    match t {
        Text::UserPrompt(inner) => user_prompt_full(&text(inner, s)),
        Text::If(p, inner) if pred(p, s) => prompt_full(inner, s),
        Text::FirstOf(items) => items.iter().find(|i| !text(i, s).is_empty()).map(|i| prompt_full(i, s)).unwrap_or_default(),
        _ => String::new(),
    }
}

/// `PromptText.full`: the same prompt, capped for the chat mirror instead.
pub fn user_prompt_full(raw: &str) -> String {
    let text = py_strip(raw);
    if text.is_empty() || text.starts_with('<') {
        return String::new();
    }
    text.chars().take(FULL_PROMPT_MAX_CHARS).collect()
}

/// `log_readers.base.join_text_blocks`.
pub fn join_blocks(content: Option<&Value>, block_type: &str) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some(block_type))
            .map(|b| py_str_opt(b.get("text")))
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Values of `<tag>…</tag>` occurrences: non-empty, without a `<` inside.
pub fn tag_values(text: &str, tag: &str, first_only: bool) -> Vec<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(found) = text[from..].find(&open) {
        let start = from + found + open.len();
        let len = text[start..].find('<').unwrap_or(text.len() - start);
        if len > 0 && text[start + len..].starts_with(&close) {
            out.push(text[start..start + len].to_owned());
            if first_only {
                break;
            }
            from = start + len + close.len();
        } else {
            from += found + 1;
        }
    }
    out
}

fn str_test(value: &str, test: StrTest) -> bool {
    match test {
        StrTest::Eq(s) => value == s,
        StrTest::In(set) => set.contains(&value),
        StrTest::StartsWith(s) => value.starts_with(s),
        StrTest::Contains(s) => value.contains(s),
        StrTest::NonEmpty => !value.is_empty(),
    }
}

pub fn pred<V: Vendor>(p: &Pred<V>, s: &Scope<V>) -> bool {
    match p {
        Pred::True => true,
        Pred::Eq(path, lit) => get(s.record, path).and_then(Value::as_str) == Some(*lit),
        Pred::In(path, set) => get(s.record, path).and_then(Value::as_str).is_some_and(|v| set.contains(&v)),
        Pred::Has(path) => get(s.record, path).is_some(),
        Pred::Truthy(path) => get(s.record, path).is_some_and(truthy),
        Pred::IsObject(path) => get(s.record, path).is_some_and(Value::is_object),
        Pred::IsList(path) => get(s.record, path).is_some_and(Value::is_array),
        Pred::IsString(path) => get(s.record, path).is_some_and(Value::is_string),
        Pred::Text(t, test) => str_test(&text(t, s), *test),
        Pred::AnyItem(path, inner) => get(s.record, path)
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().any(|item| pred(inner, &s.with_record(item)))),
        Pred::SlotSet(slot) => s.slots.is_set(*slot),
        Pred::All(ps) => ps.iter().all(|p| pred(p, s)),
        Pred::Any(ps) => ps.iter().any(|p| pred(p, s)),
        Pred::Not(p) => !pred(p, s),
        Pred::Ext(ext) => V::pred(*ext, s),
    }
}

pub fn text<V: Vendor>(t: &Text<V>, s: &Scope<V>) -> String {
    match t {
        Text::Lit(l) => (*l).to_owned(),
        Text::Py(path) => py_str_opt(get(s.record, path)),
        Text::Str(path) => get(s.record, path).and_then(Value::as_str).unwrap_or_default().to_owned(),
        Text::Slot(slot) => s.slots.get(*slot).to_owned(),
        Text::FirstOf(options) => options.iter().map(|o| text(o, s)).find(|v| !v.is_empty()).unwrap_or_default(),
        Text::Concat(parts) => parts.iter().map(|p| text(p, s)).collect(),
        Text::Blocks(path, kind) => join_blocks(get(s.record, path), kind),
        Text::Join { list, filter, item, sep, keep_empty } => get(s.record, list)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|element| {
                        let scope = s.with_record(element);
                        pred(filter, &scope).then(|| text(item, &scope))
                    })
                    .filter(|v| *keep_empty || !v.is_empty())
                    .collect::<Vec<_>>()
                    .join(sep)
            })
            .unwrap_or_default(),
        Text::TagValues(inner, tag) => tag_values(&text(inner, s), tag, false).join("\n"),
        Text::UserPrompt(inner) => user_prompt(&text(inner, s)),
        Text::Strip(inner) => py_strip(&text(inner, s)).to_owned(),
        Text::Cap(inner, max) => cap(&text(inner, s), *max),
        Text::If(p, inner) => if pred(p, s) { text(inner, s) } else { String::new() },
        Text::Num(n) => num(n, s).map(|v| v.to_string()).unwrap_or_default(),
        Text::Line => s.line.to_string(),
        Text::Offset => s.offset.to_string(),
        Text::TotalIn => s.totals.0.to_string(),
        Text::TotalOut => s.totals.1.to_string(),
        Text::Ext(ext) => V::text(*ext, s),
    }
}

/// `None` is "this record carries no reading".
pub fn num<V: Vendor>(n: &Num<V>, s: &Scope<V>) -> Option<i64> {
    match n {
        Num::Zero => Some(0),
        Num::Of(path) => Some(py_int(get(s.record, path))),
        Num::Sum(parts) => parts.iter().try_fold(0i64, |acc, p| Some(acc.saturating_add(num(p, s)?))),
        Num::Ext(ext) => V::num(*ext, s),
    }
}

/// `Num::Of` for a vendor function: Python `max(0, int(v))` of the value at the path.
pub fn int_at(record: &Value, path: &[&str]) -> i64 {
    py_int(get(record, path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn python_scalar_semantics() {
        assert_eq!(py_str(&json!(0)), "");
        assert_eq!(py_str(&json!(5)), "5");
        assert_eq!(py_str(&json!(true)), "True");
        assert_eq!(py_str(&json!(2.0)), "2.0");
        assert_eq!(py_int(Some(&json!(" 12 "))), 12);
        assert_eq!(py_int(Some(&json!(-3))), 0);
        assert_eq!(py_int(Some(&json!(3.9))), 3);
        assert_eq!(py_int(Some(&json!("1.5"))), 0);
        assert_eq!(py_int(Some(&json!(null))), 0);
        assert_eq!(py_strip("\u{1c} a \n"), "a");
    }

    #[test]
    fn tags_and_prefixes() {
        let s = "<task-notification><task-id>a1</task-id><task-id></task-id><task-id>b2</task-id><status>done</status>";
        assert_eq!(tag_values(s, "task-id", false), ["a1", "b2"]);
        assert_eq!(tag_values(s, "status", true), ["done"]);
        assert_eq!(cap(&"x".repeat(10), 4), "xx\n…\nxx");
        assert_eq!(user_prompt("  <cmd>  "), "");
        assert_eq!(user_prompt(" hi "), "hi");
    }
}
