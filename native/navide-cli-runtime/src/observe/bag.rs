//! The walk state in the log watcher's per-file `seen_keys` bag: read before
//! a walk, written back after it, in the key formats the declaration names
//! (main's own, so either reader can pick up where the other stopped). Keys
//! the declaration does not name are left untouched. The line mark, the kept
//! slots and the turn tracker are handled here; the cursor's keys by the
//! backend.
use super::activity::{ActivityState, TurnState};
use super::Backend;
use crate::decl::{KeptForm, Observe, SlotKey, TurnStamp, Vendor};
use crate::expr::{py_int_raw, py_str, truthy};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// main's line mark (`log_readers.base._ACTIVITY_HW_PREFIX`).
pub const HW_PREFIX: &str = "act_hw::";

pub(crate) fn find<'a>(bag: &'a [String], prefix: &str) -> Option<&'a str> {
    bag.iter().find_map(|k| k.strip_prefix(prefix))
}

pub(crate) fn replace(bag: &mut Vec<String>, prefix: &str, value: Option<String>) {
    bag.retain(|k| !k.starts_with(prefix));
    if let Some(value) = value {
        bag.push(format!("{prefix}{value}"));
    }
}

/// Per-partition marks `prefix + part + "::" + id` (the part split off at the
/// last `::`; an id that is not `-?digits` is ignored).
pub(crate) fn marks(bag: &[String], prefix: &str) -> BTreeMap<String, i64> {
    bag.iter()
        .filter_map(|k| k.strip_prefix(prefix))
        .filter_map(|rest| {
            let (part, id) = rest.rsplit_once("::").unwrap_or(("", rest));
            let digits = id.trim_start_matches('-');
            (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then(|| Some((part.to_owned(), id.parse().ok()?)))?
        })
        .collect()
}

/// `activity_high_water`: the first mark's number, 0 when absent or not a number.
pub fn high_water(bag: &[String]) -> usize {
    find(bag, HW_PREFIX).and_then(|n| n.parse().ok()).unwrap_or(0)
}

pub fn load<V: Vendor>(spec: &'static Observe<V>, bag: &[String]) -> ActivityState {
    let mut state = ActivityState { hw: high_water(bag), ..ActivityState::default() };
    let activity = &spec.activity;
    for kept in activity.kept {
        let value = match kept.form {
            KeptForm::Text | KeptForm::TextOnChange => find(bag, kept.prefix).map(str::to_owned),
            KeptForm::JsonText => find(bag, kept.prefix).and_then(|raw| serde_json::from_str::<Value>(raw).ok()).filter(truthy).map(|v| py_str(&v)),
        };
        if let Some(value) = value.filter(|v| !v.is_empty()) {
            state.slots.insert(kept.slot.name().to_owned(), value);
        }
    }
    if let Some(turn) = &activity.turn_key {
        let parsed = find(bag, turn.prefix).and_then(|raw| serde_json::from_str::<Value>(raw).ok());
        if let Some(Value::Object(t)) = parsed {
            let millis = matches!(activity.turn_stamp, TurnStamp::Millis);
            state.turn = Some(TurnState {
                idx: t.get("idx").and_then(py_int_raw).unwrap_or(0),
                ts: if millis { String::new() } else { t.get("ts").filter(|v| truthy(v)).map(py_str).unwrap_or_default() },
                ms: if millis { t.get("last_ms").and_then(py_int_raw).unwrap_or(0) } else { 0 },
                flushed: t.get("flushed").is_some_and(truthy),
                cancelled: t.get("cancelled").is_some_and(truthy),
            });
        }
    }
    V::Backend::load(&spec.records, bag, &mut state);
    state
}

pub fn store<V: Vendor>(spec: &'static Observe<V>, after: &ActivityState, bag: &mut Vec<String>) {
    if after.hw > high_water(bag) {
        replace(bag, HW_PREFIX, Some(after.hw.to_string()));
    }
    let activity = &spec.activity;
    for kept in activity.kept {
        let name = kept.slot.name();
        let value = after.slots.get(name).cloned().unwrap_or_default();
        match kept.form {
            KeptForm::Text => replace(bag, kept.prefix, (!value.is_empty()).then_some(value)),
            KeptForm::TextOnChange => {
                if after.written.iter().any(|w| w == name) {
                    replace(bag, kept.prefix, Some(value));
                }
            }
            KeptForm::JsonText => replace(bag, kept.prefix, (!value.is_empty()).then(|| py_json(&Value::String(value), false, true))),
        }
    }
    if let Some(turn) = &activity.turn_key {
        let json = match &after.turn {
            Some(t) => {
                let mut m = Map::new();
                m.insert("idx".into(), t.idx.into());
                if matches!(activity.turn_stamp, TurnStamp::Millis) {
                    m.insert("last_ms".into(), t.ms.into());
                    m.insert("flushed".into(), t.flushed.into());
                } else {
                    m.insert("flushed".into(), t.flushed.into());
                    m.insert("ts".into(), t.ts.clone().into());
                }
                if t.cancelled {
                    m.insert("cancelled".into(), true.into());
                }
                Some(py_json(&Value::Object(m), turn.compact, false))
            }
            None => turn.keep_null.then(|| "null".to_owned()),
        };
        replace(bag, turn.prefix, json);
    }
    V::Backend::store(&spec.records, after, bag);
}

/// Python `json.dumps(value, sort_keys=…, separators=…)` with its default
/// `ensure_ascii=True`.
pub fn py_json(value: &Value, compact: bool, sort_keys: bool) -> String {
    let mut out = String::new();
    write_json(value, compact, sort_keys, &mut out);
    out
}

fn write_json(value: &Value, compact: bool, sort_keys: bool, out: &mut String) {
    let (item, key) = if compact { (",", ":") } else { (", ", ": ") };
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&n.to_string()),
        Value::String(s) => write_str(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, v) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(item);
                }
                write_json(v, compact, sort_keys, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            if sort_keys {
                entries.sort_by(|a, b| a.0.cmp(b.0));
            }
            out.push('{');
            for (i, (k, v)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push_str(item);
                }
                write_str(k, out);
                out.push_str(key);
                write_json(v, compact, sort_keys, out);
            }
            out.push('}');
        }
    }
}

fn write_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 || (c as u32) > 0x7e => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    out.push_str(&format!("\\u{unit:04x}"));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::py_json;
    use serde_json::json;

    #[test]
    fn dumps_like_python() {
        // json.dumps({"b": "é😀\n", "a": [1, None]}, sort_keys=True)
        let bs = "\\";
        let want = format!("{{\"a\": [1, null], \"b\": \"{bs}u00e9{bs}ud83d{bs}ude00{bs}n\"}}");
        assert_eq!(py_json(&json!({"b": "é😀\n", "a": [1, null]}), false, true), want);
        assert_eq!(py_json(&json!({"idx": 0, "last_ms": 5, "flushed": false}), true, false), r#"{"idx":0,"last_ms":5,"flushed":false}"#);
        // ensure_ascii escapes everything outside " ".."~", DEL included.
        assert_eq!(py_json(&json!("\u{7f}"), false, false), r#""\u007f""#);
    }
}
