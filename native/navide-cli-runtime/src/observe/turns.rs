//! Per-turn usage. `exact`: the transcript names its turns (the declaration
//! says which records open one, which are model calls, which close one).
//! `inferred`: main's generic cut of usage on `turn_complete` timestamps.
use super::activity::{self, At};
use super::{file, ActivityEvent, Error, File, TurnCall, TurnUsage, UsageEvent};
use crate::decl::{Each, ExactTurns, Num, OpenMode, Orphan, PromptMerge, SessionFilter, Vendor};
use crate::expr::{self, get, user_prompt, Scope, Slots};
use crate::time::{sort_key, turn_timestamp};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};

const TURN_EXCERPT_MAX_CHARS: usize = 80;

/// `turn_excerpt`: whitespace collapsed, capped.
fn excerpt(text: &str) -> String {
    text.split(expr::py_space).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ").chars().take(TURN_EXCERPT_MAX_CHARS).collect()
}

/// `merge_prompt_excerpt`: the first typed prompt wins; a `<`-wrapper only
/// stands in until one arrives.
fn merge(current: &str, text: &str) -> String {
    let typed = user_prompt(text);
    if !typed.is_empty() {
        return if !current.is_empty() && !current.starts_with('<') { current.to_owned() } else { excerpt(&typed) };
    }
    if current.is_empty() { excerpt(text) } else { current.to_owned() }
}

fn some(text: String) -> Option<String> {
    (!text.is_empty()).then_some(text)
}

fn scope<'a, V: Vendor>(record: &'a Value, line: usize, slots: &'a Slots<V>, entry_key: &'a str) -> Scope<'a, V> {
    Scope { line, entry_key, ..Scope::of(record, slots) }
}

/// The entries one call record is made of: `(entry key, entry object)`.
fn entries<'v>(each: Option<&Each>, record: &'v Value) -> Vec<(String, &'v Value)> {
    let Some(each) = each else { return vec![(String::new(), record)] };
    match get(record, each.map).and_then(Value::as_object).filter(|m| !m.is_empty()) {
        Some(map) => map.iter().map(|(k, v)| (k.clone(), v)).collect(),
        None => get(record, each.fallback).map(|v| vec![(String::new(), v)]).unwrap_or_default(),
    }
}

pub fn exact<V: Vendor>(file: &File<'_, V>, spec: &'static ExactTurns<V>, session_id: &str) -> Result<Vec<TurnUsage>, Error> {
    let mut slots = file.slots(spec.slots)?;
    let session = file.spec.session;
    let mut turns: Vec<TurnUsage> = Vec::new();
    let mut by_key: HashMap<String, usize> = HashMap::new();
    let mut current: Option<usize> = None;
    let mut pending: Option<TurnUsage> = None;
    let mut saw_open = false;
    let mut seen: HashSet<String> = HashSet::new();
    let mut prev: [i64; 4] = [0; 4];
    let call = &spec.call;
    file::all_lines(file.path, 0, spec.strict_utf8, |line, _stripped, value| {
        let Some(record) = value.filter(|v| v.is_object()) else { return true };
        if let SessionFilter::Record(t) = &spec.filter {
            if !session_id.is_empty() && expr::text(t, &scope(record, line, &slots, "")) != session_id {
                return true;
            }
        }
        activity::slot_rules(file, spec.effects, record, At::line(line, 0), &mut slots);
        let s = scope(record, line, &slots, "");
        if spec.skip.as_ref().is_some_and(|skip| expr::pred(skip, &s)) {
            return true;
        }
        if let Some(open) = spec.open.as_ref().filter(|o| expr::pred(&o.when, &s)) {
            saw_open = true;
            let sid = slots.of(session).to_owned();
            let started = some(expr::text(&open.started, &s));
            let turn = match &open.mode {
                OpenMode::ByKey(key) => {
                    let key = expr::text(key, &s);
                    let index = *by_key.entry(key).or_insert_with(|| {
                        turns.push(TurnUsage::new(sid.clone(), started.clone()));
                        turns.len() - 1
                    });
                    current = Some(index);
                    &mut turns[index]
                }
                OpenMode::Each => {
                    turns.push(TurnUsage::new(sid, started));
                    let index = turns.len() - 1;
                    current = Some(index);
                    &mut turns[index]
                }
                OpenMode::Join => {
                    let turn = pending.get_or_insert_with(|| TurnUsage::new(sid, None));
                    if turn.started_at.is_none() {
                        turn.started_at = started;
                    }
                    turn
                }
            };
            let prompt = expr::text(&open.prompt, &s);
            turn.prompt_excerpt = match open.merge {
                PromptMerge::Excerpt => excerpt(&prompt),
                PromptMerge::Merge => merge(&turn.prompt_excerpt, &prompt),
            };
            return true;
        }
        if !expr::pred(&call.when, &s) {
            return true;
        }
        if call.orphan == Orphan::Drop && current.is_none() {
            return true;
        }
        let ts = some(expr::text(&call.ts, &s));
        let mut made = Vec::new();
        for (entry_key, entry) in entries(call.each.as_ref(), record) {
            if !entry.is_object() {
                continue;
            }
            let es = scope(entry, line, &slots, &entry_key);
            let n = |num: &Num<V>| expr::num(num, &es).unwrap_or(0);
            let mut counts = [n(&call.input), n(&call.cache_read), n(&call.cache_creation), n(&call.output)];
            if call.cumulative {
                let delta = [counts[0] - prev[0], counts[1] - prev[1], counts[2] - prev[2], counts[3] - prev[3]];
                prev = counts;
                if delta.iter().any(|d| *d < 0) || (call.skip_zero && delta.iter().all(|d| *d == 0)) {
                    continue;
                }
                counts = delta;
            }
            if call.input_includes_cache {
                counts[0] = (counts[0] - counts[1] - counts[2]).max(0);
            }
            let key = call.key.as_ref().map(|k| expr::text(k, &es));
            if let Some(key) = &key {
                if key == call.key_invalid || seen.contains(key) {
                    continue;
                }
            }
            if !call.cumulative && call.skip_zero && counts.iter().sum::<i64>() == 0 {
                continue;
            }
            if let Some(key) = key {
                seen.insert(key);
            }
            made.push(TurnCall {
                ts: ts.clone(),
                model: expr::text(&call.model, &es),
                input: counts[0],
                cache_read: counts[1],
                cache_creation: counts[2],
                output: counts[3],
                cli_version: expr::text(&call.cli_version, &es),
            });
        }
        if call.orphan != Orphan::ToClose {
            for c in made {
                let index = match current {
                    Some(i) if call.orphan == Orphan::Drop || saw_open => i,
                    _ => {
                        turns.push(TurnUsage::new(slots.of(session).to_owned(), ts.clone()));
                        current = Some(turns.len() - 1);
                        turns.len() - 1
                    }
                };
                let turn = &mut turns[index];
                turn.ended_at = ts.clone().or(turn.ended_at.take());
                turn.add_call(c);
            }
            return true;
        }
        let turn = pending.get_or_insert_with(|| TurnUsage::new(slots.of(session).to_owned(), None));
        for c in made {
            turn.add_call(c);
        }
        if let Some(close) = spec.close.as_ref().filter(|c| expr::pred(&c.when, &s)) {
            if let Some(mut turn) = pending.take() {
                turn.ended_at = some(expr::text(&close.ended, &s));
                if let Some(t) = &close.session {
                    turn.session_id = expr::text(t, &s);
                }
                turn.model_calls = close.model_calls.as_ref().and_then(|n| expr::num(n, &s)).filter(|v| *v != 0);
                if !(close.drop_empty && turn.total() == 0) {
                    turns.push(turn);
                }
            }
        }
        true
    })?;
    if matches!(spec.filter, SessionFilter::File) && !session_id.is_empty() {
        let stem = file.path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
        if session_id != slots.of(session) && session_id != stem {
            return Ok(Vec::new());
        }
    }
    let keep_empty_calls = spec.close.as_ref().is_some_and(|c| c.drop_empty);
    let mut out: Vec<TurnUsage> = turns.into_iter().filter(|t| keep_empty_calls || !t.calls.is_empty()).collect();
    for (n, turn) in out.iter_mut().enumerate() {
        turn.turn_index = n + 1;
    }
    Ok(out)
}

/// main's `LogReader.turns_for_session`: each call goes to the first
/// boundary not earlier than it; calls past the last boundary form the open
/// trailing turn; the prompt comes from the user-prompt event in the window.
pub fn inferred(usages: &[UsageEvent], activity: &[ActivityEvent], session_id: &str) -> Vec<TurnUsage> {
    let usages: Vec<&UsageEvent> = usages.iter().filter(|u| session_id.is_empty() || u.session_id == session_id).collect();
    let activity: Vec<&ActivityEvent> = activity.iter().filter(|a| session_id.is_empty() || a.session_id == session_id).collect();
    let mut boundaries: Vec<f64> =
        activity.iter().filter(|a| a.event_type == "turn_complete").filter_map(|a| sort_key(&a.timestamp)).collect();
    boundaries.sort_by(f64::total_cmp);
    let mut prompts: Vec<(f64, &str, &str)> = activity
        .iter()
        .filter(|a| a.event_type == "agent_active" && ["user", "prompt", "user_message"].contains(&a.detail.as_str()) && !a.text.is_empty())
        .filter_map(|a| Some((sort_key(&a.timestamp)?, a.timestamp.as_str(), a.text.as_str())))
        .collect();
    prompts.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(b.1)).then_with(|| a.2.cmp(b.2)));
    let window = |key: Option<f64>| -> usize {
        match key {
            None => boundaries.len(),
            Some(k) => boundaries.iter().position(|edge| k <= *edge).unwrap_or(boundaries.len()),
        }
    };
    let sid = if session_id.is_empty() { usages.first().map(|u| u.session_id.clone()).unwrap_or_default() } else { session_id.to_owned() };
    let mut turns: BTreeMap<usize, TurnUsage> = BTreeMap::new();
    for (key, stamp, text) in &prompts {
        let turn = turns.entry(window(Some(*key))).or_insert_with(|| TurnUsage::new(sid.clone(), None));
        if turn.prompt_excerpt.is_empty() {
            turn.prompt_excerpt = excerpt(text);
            turn.started_at = turn_timestamp(stamp);
        }
    }
    let mut ordered = usages.clone();
    // Python's `key or float("inf")`: a key of exactly 0 sorts last too.
    ordered.sort_by(|a, b| {
        let k = |u: &UsageEvent| sort_key(&u.timestamp).filter(|k| *k != 0.0).unwrap_or(f64::INFINITY);
        k(a).total_cmp(&k(b))
    });
    for usage in ordered {
        let turn = turns.entry(window(sort_key(&usage.timestamp))).or_insert_with(|| TurnUsage::new(sid.clone(), None));
        let stamp = turn_timestamp(&usage.timestamp);
        turn.add_call(TurnCall {
            ts: stamp.clone(),
            model: usage.model.clone(),
            input: usage.input_tokens,
            cache_read: 0,
            cache_creation: 0,
            output: usage.output_tokens,
            cli_version: String::new(),
        });
        if let Some(stamp) = stamp {
            if turn.started_at.is_none() {
                turn.started_at = Some(stamp.clone());
            }
            turn.ended_at = Some(stamp);
        }
    }
    let mut out: Vec<TurnUsage> = turns.into_values().filter(|t| !t.calls.is_empty()).collect();
    for (n, turn) in out.iter_mut().enumerate() {
        turn.turn_index = n + 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{excerpt, merge};

    #[test]
    fn excerpts_follow_main() {
        assert_eq!(excerpt("  a \n b  "), "a b");
        assert_eq!(merge("", "<cmd>x</cmd>"), "<cmd>x</cmd>");
        assert_eq!(merge("<cmd>x</cmd>", "hello"), "hello");
        assert_eq!(merge("first", "second"), "first");
    }
}
