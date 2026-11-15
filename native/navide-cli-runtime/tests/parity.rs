//! Replays the parity fixtures (`tests/parity/*.json`) recorded from main's
//! Python readers by `backend/tests/test_cli_runtime_parity.py`: the same
//! bytes, mtimes and clock, read the way the log watcher reads them, must give
//! the same usage events and checkpoints, activity events and turns, and
//! (where a fixture records it) the same open read problem.
use navide_cli_runtime::decl::{Form, Read, Vendor};
use navide_cli_runtime::observe::{trace, Backend, Error};
use navide_cli_runtime::registry::{self, Visit};
use serde_json::{Map, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

struct Dir(PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The fixture's normalisation: paths relative to the root, no `identity` (dev:inode).
fn norm(value: Value, root: &str) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.into_iter().filter(|(k, _)| k != "identity").map(|(k, v)| (k, norm(v, root))).collect()),
        Value::Array(items) => Value::Array(items.into_iter().map(|v| norm(v, root)).collect()),
        Value::String(s) => Value::String(drop_identity(&s.replace(root, "<root>"))),
        other => other,
    }
}

/// A byte cursor serialised into a seen-keys bag key carries `"identity": "…", ` too.
fn drop_identity(s: &str) -> String {
    const KEY: &str = "\"identity\": \"";
    let Some(start) = s.find(KEY) else { return s.to_owned() };
    let rest = &s[start + KEY.len()..];
    match rest.find("\", ") {
        Some(end) => format!("{}{}", &s[..start], &rest[end + 3..]),
        None => s.to_owned(),
    }
}

fn base64(text: &str) -> Vec<u8> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => panic!("not base64: {c}"),
    };
    let digits: Vec<u8> = text.bytes().filter(|c| *c != b'=').map(value).collect();
    let mut out = Vec::with_capacity(digits.len() * 3 / 4);
    for chunk in digits.chunks(4) {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (i, d)| acc | (u32::from(*d) << (18 - 6 * i)));
        out.extend_from_slice(&n.to_be_bytes()[1..chunk.len()]);
    }
    out
}

/// main's read-problem registry for one CLI, as the seam keeps it from the
/// runtime's `reads`: one entry per failing read, in the order first hit.
#[derive(Default)]
struct Problems(Vec<(&'static str, Value)>);

impl Problems {
    fn apply(&mut self, reads: Vec<Read>, path: &Path) {
        for read in reads {
            let at = self.0.iter().position(|(key, _)| *key == read.key);
            match (read.problem, at) {
                (None, Some(at)) => drop(self.0.remove(at)),
                (None, None) => {}
                (Some(problem), at) => {
                    let entry = serde_json::json!({"status": problem.status, "reason": problem.reason, "path": path.to_string_lossy(), "detail": problem.detail});
                    match at {
                        Some(at) => self.0[at].1 = entry,
                        None => self.0.push((read.key, entry)),
                    }
                }
            }
        }
    }

    /// `read_problem()`: the oldest open problem, with how many are open.
    fn oldest(&self) -> Value {
        let Some((_, first)) = self.0.first() else { return Value::Null };
        let mut entry = first.clone();
        entry["problems"] = self.0.len().into();
        entry
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_else(|| panic!("fixture field {key}"))
}

/// The state the Python reader leaves behind when the runtime hands it a
/// call (`Error::PythonReads`), put back into the form the runtime reads: the
/// fixture holds it without the file's `identity` (dev:inode), which the
/// runtime's own checkpoints and byte-cursor keys carry.
fn with_identity(path: &Path, checkpoint: &Value) -> Map<String, Value> {
    let mut checkpoint = checkpoint.as_object().cloned().unwrap_or_default();
    if matches!(checkpoint.get("kind").and_then(Value::as_str), Some("jsonl" | "sqlite")) {
        let identity = navide_cli_runtime::observe::file::identity(&std::fs::metadata(path).unwrap());
        checkpoint.insert("identity".into(), identity.into());
    }
    checkpoint
}

/// The same for a seen-keys bag key that holds a byte cursor.
fn bag_with_identity(path: &Path, key: &str) -> String {
    if !key.contains("\"kind\": \"jsonl\"") {
        return key.to_owned();
    }
    let identity = navide_cli_runtime::observe::file::identity(&std::fs::metadata(path).unwrap());
    key.replacen("\"anchor\"", &format!("\"identity\": \"{identity}\", \"anchor\""), 1)
}

fn replay(fixture: &Path) -> Vec<String> {
    let scenario: Value = serde_json::from_str(&std::fs::read_to_string(fixture).unwrap()).unwrap();
    let name = fixture.file_stem().unwrap().to_string_lossy().into_owned();
    let vendor = str_of(&scenario, "vendor");
    let nanos = std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = Dir(std::env::temp_dir().join(format!("navide-parity-{name}-{}-{nanos}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let root = dir.0.to_string_lossy().into_owned();
    let write_sidecars = |files: &Value| {
        for (rel, text) in files.as_object().into_iter().flatten() {
            let path = dir.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, text.as_str().unwrap()).unwrap();
        }
    };
    write_sidecars(&scenario["sidecars"]);
    let path = dir.0.join(str_of(&scenario, "file"));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();

    let mut observer = registry::observer(vendor).unwrap_or_else(|| panic!("{name}: {vendor} declares no observe"));
    // What Python recorded, with each normalised cwd put back as the
    // transcript wrote it: the runtime hands it on as written, and the seam
    // applies the form the declaration names.
    let as_written = observer.cwd_form() != Form::Written;
    let expected = |value: &Value| -> Value {
        let mut text = value.to_string();
        for pair in scenario["as_written"].as_array().into_iter().flatten().filter(|_| as_written) {
            text = text.replace(pair[0].as_str().unwrap(), pair[1].as_str().unwrap());
        }
        serde_json::from_str(&text).unwrap()
    };
    let mut checkpoint = Map::new();
    let mut bag: Vec<String> = Vec::new();
    let mut problems = Problems::default();
    let mut failures = Vec::new();
    // The calls the runtime hands to the Python reader (`<op>@<step>`, `turns`).
    let python_reads: Vec<String> = scenario["python_reads"].as_array().into_iter().flatten().map(|r| r.as_str().unwrap().to_owned()).collect();
    for (n, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
        write_sidecars(&step["sidecars"]);
        if str_of(step, "mode") == "db" {
            // The database file exactly as main's readers read it after the step.
            std::fs::write(&path, base64(str_of(step, "db"))).unwrap();
            let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            file.set_modified(UNIX_EPOCH + Duration::from_secs_f64(step["mtime"].as_f64().unwrap())).unwrap();
        } else {
            let mode = str_of(step, "mode");
            // "replace": a new file renamed over the old one (its identity changes).
            let target = if mode == "replace" { path.with_extension("new") } else { path.clone() };
            let mut file = std::fs::OpenOptions::new().create(true).write(true).append(mode == "append").truncate(mode != "append").open(&target).unwrap();
            file.write_all(str_of(step, "text").as_bytes()).unwrap();
            if let Some(raw) = step["b64"].as_str() {
                file.write_all(&base64(raw)).unwrap();
            }
            drop(file);
            if mode == "replace" {
                std::fs::rename(&target, &path).unwrap();
            }
            let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            file.set_modified(UNIX_EPOCH + Duration::from_secs_f64(step["mtime"].as_f64().unwrap())).unwrap();
        }
        for key in step["checkpoint_drop"].as_array().into_iter().flatten() {
            checkpoint.shift_remove(key.as_str().unwrap());
        }
        for key in step["bag_add"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            if !bag.iter().any(|k| k == key) {
                bag.push(key.to_owned());
            }
        }
        observer.set_clock(step["now"].as_f64());
        // A call the fixture names is handed to the Python reader, which then
        // holds the state: the replay takes it from what Python recorded.
        let hands_usage = python_reads.contains(&format!("usage@{n}"));
        match (observer.usage(&path, &checkpoint), hands_usage) {
            (Err(Error::PythonReads(_)), true) => checkpoint = with_identity(&path, &step["expect"]["usage"]["checkpoint"]),
            (Ok(read), false) => {
                problems.apply(observer.take_reads(), &path);
                checkpoint = read.checkpoint.clone();
                let usage = norm(serde_json::to_value(&read).unwrap(), &root);
                if usage != expected(&step["expect"]["usage"]) {
                    failures.push(format!("{name} step {n} usage\n  rust:   {usage}\n  python: {}", step["expect"]["usage"]));
                }
            }
            (other, handed) => {
                failures.push(format!("{name} step {n}: usage answered {:?}, handed to python wanted: {handed}", other.map(|r| r.events.len())));
                continue;
            }
        }
        // main's walk raises on a line that is not UTF-8, after saving its state.
        let wants_error = step["expect"]["activity_error"].as_str();
        let hands_activity = python_reads.contains(&format!("activity@{n}"));
        let events = match (observer.activity_bag(&path, &mut bag), wants_error, hands_activity) {
            (Err(Error::PythonReads(_)), _, true) => {
                bag = step["expect"]["bag"].as_array().unwrap().iter().map(|key| bag_with_identity(&path, key.as_str().unwrap())).collect();
                Vec::new()
            }
            (Ok(events), None, false) => events,
            (Err(Error::Decode { .. }), Some("decode"), false) => Vec::new(),
            (other, _, handed) => {
                failures.push(format!(
                    "{name} step {n} activity: got {:?}, python error: {wants_error:?}, handed to python wanted: {handed}",
                    other.map(|e| e.len())
                ));
                Vec::new()
            }
        };
        problems.apply(observer.take_reads(), &path);
        if hands_activity {
            continue;
        }
        if let Some(wanted) = step["expect"].get("problem") {
            let got = norm(problems.oldest(), &root);
            if got != *wanted {
                failures.push(format!("{name} step {n} read problem\n  rust:   {got}\n  python: {wanted}"));
            }
        }
        let activity = norm(serde_json::to_value(&events).unwrap(), &root);
        if activity != expected(&step["expect"]["activity"]) {
            failures.push(format!("{name} step {n} activity\n  rust:   {activity}\n  python: {}", step["expect"]["activity"]));
        }
        bag.sort();
        let got = norm(serde_json::to_value(&bag).unwrap(), &root);
        if got != step["expect"]["bag"] {
            failures.push(format!("{name} step {n} seen-keys bag\n  rust:   {got}\n  python: {}", step["expect"]["bag"]));
        }
    }
    match (observer.turns(&path, ""), scenario["turns"]["error"].as_str(), python_reads.contains(&"turns".to_owned())) {
        (Ok(turns), None, false) => {
            let turns = norm(serde_json::to_value(turns).unwrap(), &root);
            if turns != scenario["turns"] {
                failures.push(format!("{name} turns\n  rust:   {turns}\n  python: {}", scenario["turns"]));
            }
        }
        (Err(Error::Decode { .. }), Some("decode"), false) | (Err(Error::PythonReads(_)), _, true) => {}
        (other, wanted, handed) => {
            failures.push(format!("{name} turns: got {:?}, python error: {wanted:?}, handed to python wanted: {handed}", other.map(|t| t.len())))
        }
    }
    failures
}

/// The declared rules no fixture record matched.
#[derive(Default)]
struct Unmatched(Vec<String>);

impl Visit for Unmatched {
    fn vendor<V: Vendor>(&mut self, file: &'static str) {
        let Some(observe) = V::OBSERVE else { return };
        for (n, rule) in observe.activity.rules.iter().enumerate() {
            if !trace::has_matched(rule) {
                self.0.push(format!("{file}: activity rule {n} ({:?})", rule.when));
            }
        }
        for (n, rule) in <V::Backend as Backend<V>>::usage_rules(&observe.records).into_iter().enumerate() {
            if !trace::has_matched(rule) {
                self.0.push(format!("{file}: usage rule {n} ({:?})", rule.when));
            }
        }
    }
}

/// One test, so that the coverage check sees every fixture's replay.
#[test]
fn every_fixture_matches_mains_readers_and_every_rule_has_a_record() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("parity");
    let mut fixtures: Vec<PathBuf> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).filter(|p| p.extension().is_some_and(|e| e == "json")).collect();
    fixtures.sort();
    assert!(!fixtures.is_empty(), "no parity fixtures in {}", dir.display());
    trace::start();
    let failures: Vec<String> = fixtures.iter().flat_map(|f| replay(f)).collect();
    assert!(failures.is_empty(), "{} mismatch(es):\n{}", failures.len(), failures.join("\n"));

    // A rule no recorded transcript reaches is a rule nobody compared with
    // main's reader: record a step for it (from Python) in
    // backend/tests/test_cli_runtime_parity.py.
    let mut unmatched = Unmatched::default();
    registry::each(&mut unmatched);
    assert!(unmatched.0.is_empty(), "{} declared rule(s) without a fixture record:\n{}", unmatched.0.len(), unmatched.0.join("\n"));
}
