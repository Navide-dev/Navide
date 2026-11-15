//! `serve`: one JSON request per stdin line, one JSON response per stdout
//! line. Responses carry the request's id and may come back in another
//! order: the reads of one file always go to the same worker (so they stay
//! in order, and the reader memory for that file lives in one place), and
//! different files are read side by side, so one long read does not hold up
//! the others. A request that panics answers an error and the process keeps
//! serving.
use crate::observe::{Error, HAS_FILE_IDENTITY};
use crate::registry::{AnyObserver, ALL};
use crate::resume::{self, Command};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

/// Readers in flight at once. The backend's own callers are a handful of
/// threads (the watcher, the token monitor, the ledgers).
pub const WORKERS: usize = 4;

#[derive(Deserialize)]
pub struct Request {
    #[serde(default)]
    pub id: Value,
    pub op: String,
    #[serde(default)]
    pub vendor: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub checkpoint: Map<String, Value>,
    /// The watcher's seen-keys bag for the file (activity).
    #[serde(default)]
    pub bag: Vec<String>,
    #[serde(default)]
    pub session_id: String,
    /// A saved launch command, as a string or an argv (`resume_id`).
    #[serde(default)]
    pub command: Value,
    /// The caller's clock (seconds since the epoch) for idle flushes.
    #[serde(default)]
    pub now: Option<f64>,
}

/// One worker's observers, by CLI key.
pub type Observers = HashMap<&'static str, AnyObserver>;

pub fn observers() -> Observers {
    AnyObserver::all().into_iter().map(|observer| (observer.key(), observer)).collect()
}

/// A failed request: what went wrong and of which kind. `unsupported` is the
/// declared "this store is the Python reader's" answer, and `python` is "this
/// call holds a record only Python is sure to read" (see
/// `Error::PythonReads`); `io` is a file the caller's reader decides on.
/// Every other kind is a fault.
pub struct Failure {
    pub kind: &'static str,
    pub error: String,
}

impl From<Error> for Failure {
    fn from(err: Error) -> Self {
        let kind = match err {
            Error::Unsupported(_) => "unsupported",
            Error::Io(_) => "io",
            Error::Decode { .. } => "decode",
            Error::PythonReads(_) => "python",
        };
        Failure { kind, error: err.to_string() }
    }
}

fn bad(error: impl Into<String>) -> Failure {
    Failure { kind: "request", error: error.into() }
}

fn observer<'a>(observers: &'a mut Observers, vendor: &str) -> Result<&'a mut AnyObserver, Failure> {
    observers.get_mut(vendor).ok_or_else(|| bad(format!("no observe declaration for {vendor:?}")))
}

/// The key beside the CLIs in the `observes` answer that says which build
/// answered. No CLI is called this.
pub const RUNTIME_KEY: &str = "_runtime";

/// FNV-1a over the bytes: a fingerprint to compare two copies of a text, not a
/// defence against anyone.
fn fingerprint(bytes: &[u8]) -> String {
    let hash = bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3));
    format!("{hash:016x}")
}

/// What `observes` answers: each observed CLI with the form its cwd is to
/// be put in (none where files have no identity: the checkpoints this process
/// shares with the Python readers could never match), and under
/// `RUNTIME_KEY` the crate's version and the fingerprint of the declarations
/// it prints (`declarations launch`), so that the backend can tell a binary
/// built from other declarations than its own checked-in copy.
fn observed(observers: &Observers) -> Value {
    let mut answer = Map::new();
    if HAS_FILE_IDENTITY {
        for (key, observer) in observers {
            answer.insert((*key).to_owned(), json!({"cwd": observer.cwd_form()}));
        }
    }
    answer.insert(RUNTIME_KEY.to_owned(), json!({"version": env!("CARGO_PKG_VERSION"), "declarations": fingerprint(crate::registry::launch_json().as_bytes())}));
    Value::Object(answer)
}

/// What a read has to tell the caller beside its result: `notes`, which
/// main's reader would have logged while reading, and `reads`, the outcomes
/// main's reader would have recorded in its read-problem registry.
fn said(observer: &mut AnyObserver, mut result: Value) -> Value {
    result["notes"] = json!(observer.take_notes());
    result["reads"] = json!(observer.take_reads());
    result
}

/// Answer one request.
pub fn handle(observers: &mut Observers, req: Request) -> Result<Value, Failure> {
    let path = Path::new(&req.path);
    match req.op.as_str() {
        "ping" => Ok(json!({"vendors": ALL.iter().map(|c| c.key).collect::<Vec<_>>()})),
        "observes" => Ok(observed(observers)),
        "usage" => {
            let observer = observer(observers, &req.vendor)?;
            let read = observer.usage(path, &req.checkpoint)?;
            Ok(said(observer, json!({"events": read.events, "checkpoint": read.checkpoint})))
        }
        "activity" => {
            let mut bag = req.bag;
            let observer = observer(observers, &req.vendor)?;
            observer.set_clock(req.now);
            match observer.activity_bag(path, &mut bag) {
                Ok(events) => Ok(said(observer, json!({"events": events, "bag": bag}))),
                // The walk's state still moved (main's `finally`), so the bag is returned with the error.
                Err(err @ Error::Decode { .. }) => Ok(said(observer, json!({"events": [], "bag": bag, "error": err.to_string()}))),
                // Unreadable: the caller's own reader decides (main returns no events).
                Err(err) => Err(err.into()),
            }
        }
        "turns" => {
            let observer = observer(observers, &req.vendor)?;
            observer.set_clock(req.now);
            match observer.turns(path, &req.session_id) {
                Ok(turns) => Ok(said(observer, json!({"turns": turns}))),
                // main's strict text-mode pass raises on a file that is not UTF-8.
                Err(err @ Error::Decode { .. }) => Ok(said(observer, json!({"turns": [], "error": err.to_string()}))),
                Err(err) => Err(err.into()),
            }
        }
        "resume_id" => {
            let cli = crate::cli(&req.vendor).ok_or_else(|| bad("unknown vendor"))?;
            let id = match &req.command {
                Value::Array(items) => {
                    let argv: Vec<String> = items.iter().map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned)).collect();
                    resume::id_from_command(cli, &Command::Argv(&argv))
                }
                Value::String(text) => resume::id_from_command(cli, &Command::Text(text)),
                Value::Null => String::new(),
                other => resume::id_from_command(cli, &Command::Text(&other.to_string())),
            };
            Ok(json!(id))
        }
        other => Err(bad(format!("unknown op {other:?}"))),
    }
}

pub type Handler = fn(&mut Observers, Request) -> Result<Value, Failure>;

/// One request, answered: a panic is an error answer, and the observer it
/// may have left half-updated (the request's CLI's) is replaced; what it
/// remembered is only an optimisation. Every other CLI's keeps its memory.
fn answer(observers: &mut Observers, req: Request, handler: Handler) -> Value {
    let id = req.id.clone();
    let key = observers.get_key_value(req.vendor.as_str()).map(|(key, _)| *key);
    match catch_unwind(AssertUnwindSafe(|| handler(observers, req))) {
        Ok(Ok(result)) => json!({"id": id, "ok": true, "result": result}),
        Ok(Err(failure)) => json!({"id": id, "ok": false, "kind": failure.kind, "error": failure.error}),
        Err(panic) => {
            if let Some(fresh) = key.and_then(crate::registry::observer) {
                observers.insert(fresh.key(), fresh);
            }
            let what = panic.downcast_ref::<&str>().map(|s| (*s).to_owned()).or_else(|| panic.downcast_ref::<String>().cloned()).unwrap_or_default();
            json!({"id": id, "ok": false, "kind": "panic", "error": format!("panic: {what}")})
        }
    }
}

fn write(output: &Mutex<impl Write>, response: &Value) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(response)?;
    line.push(b'\n');
    let mut output = output.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    output.write_all(&line)?;
    output.flush()
}

/// The worker a request belongs to: the same file always the same one.
fn lane(req: &Request, workers: usize) -> usize {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (&req.vendor, &req.path).hash(&mut hasher);
    (hasher.finish() % workers as u64) as usize
}

/// A request line as a `Request`, or the answer that refuses it. The line is
/// read as a JSON value first, so whatever is wrong with a field, the answer
/// carries the request's id and the caller hears of it at once instead of
/// waiting out its timeout.
///
/// A line `serde_json` rejects that Python's `json` may read (a lone surrogate
/// escape: a path with undecodable bytes) is refused as `python`: the
/// caller's own reader reads that call. The backend does not send those;
/// this is for a caller that does.
fn parse_request(line: &[u8]) -> Result<Request, Value> {
    let refuse = |id: Value, kind: &str, error: String| json!({"id": id, "ok": false, "kind": kind, "error": error});
    let (text, utf8) = match std::str::from_utf8(line) {
        Ok(text) => (std::borrow::Cow::Borrowed(text), true),
        Err(_) => (String::from_utf8_lossy(line), false),
    };
    let value = match serde_json::from_str::<Value>(&text) {
        Ok(value) => value,
        Err(err) => {
            let id = crate::pyjson::lenient(&text).map_or(Value::Null, |value| value["id"].clone());
            let kind = if matches!(crate::pyjson::parse(&text), crate::pyjson::Parsed::Python) { "python" } else { "request" };
            return Err(refuse(id, kind, format!("bad request: {err}")));
        }
    };
    let id = value["id"].clone();
    if !utf8 {
        return Err(refuse(id, "request", "bad request: the line is not UTF-8".to_owned()));
    }
    serde_json::from_value::<Request>(value).map_err(|err| refuse(id, "request", format!("bad request: {err}")))
}

pub fn serve(input: impl BufRead, output: impl Write + Send + 'static) -> std::io::Result<()> {
    serve_with(input, output, WORKERS, handle)
}

pub fn serve_with(input: impl BufRead, output: impl Write + Send + 'static, workers: usize, handler: Handler) -> std::io::Result<()> {
    let output = Arc::new(Mutex::new(output));
    let mut lanes: Vec<Sender<Request>> = Vec::new();
    let mut threads = Vec::new();
    for _ in 0..workers.max(1) {
        let (sender, receiver) = channel::<Request>();
        let output = Arc::clone(&output);
        lanes.push(sender);
        threads.push(std::thread::spawn(move || {
            let mut observers = observers();
            for req in receiver {
                // A closed pipe ends the process from the reading side.
                let _ = write(&output, &answer(&mut observers, req, handler));
            }
        }));
    }
    let mut result = Ok(());
    let mut input = input;
    let mut line = Vec::new();
    loop {
        // Bytes, not `lines()`: a line that is not UTF-8 is a bad request to
        // answer, not an error that ends the process.
        line.clear();
        match input.read_until(b'\n', &mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(err) => {
                result = Err(err);
                break;
            }
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let sent = match parse_request(&line) {
            Ok(req) => {
                let lane = lane(&req, lanes.len());
                lanes[lane].send(req).map_err(|_| std::io::Error::other("worker gone"))
            }
            Err(refusal) => write(&output, &refusal),
        };
        if let Err(err) = sent {
            result = Err(err);
            break;
        }
    }
    drop(lanes);
    for thread in threads {
        let _ = thread.join();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// A writer the test can read back after `serve` has finished.
    #[derive(Clone, Default)]
    struct Shared(Arc<Mutex<Vec<u8>>>);

    impl Write for Shared {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(data);
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn run(requests: &str, workers: usize, handler: Handler) -> Vec<Value> {
        run_bytes(requests.as_bytes(), workers, handler)
    }

    fn run_bytes(requests: &[u8], workers: usize, handler: Handler) -> Vec<Value> {
        let out = Shared::default();
        serve_with(Cursor::new(requests.to_vec()), out.clone(), workers, handler).unwrap();
        let bytes = out.0.lock().unwrap().clone();
        String::from_utf8(bytes).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    /// `run` with the panics it provokes on purpose kept off the test output.
    /// The hook is the process's, so two tests must not swap it at once: the
    /// second would save the first's silent hook and leave it in place.
    fn quietly<T>(run: impl FnOnce() -> T) -> T {
        static SWAP: Mutex<()> = Mutex::new(());
        let _one_at_a_time = SWAP.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let out = run();
        std::panic::set_hook(previous);
        out
    }

    fn by_id(answers: &[Value], id: i64) -> &Value {
        answers.iter().find(|a| a["id"] == id).unwrap_or_else(|| panic!("no answer for {id}"))
    }

    #[test]
    fn a_panicking_request_answers_an_error_and_the_next_one_is_served() {
        fn handler(observers: &mut Observers, req: Request) -> Result<Value, Failure> {
            if req.op == "boom" {
                panic!("declared rule blew up");
            }
            handle(observers, req)
        }
        let answers = quietly(|| run("{\"id\":1,\"op\":\"boom\"}\n{\"id\":2,\"op\":\"ping\"}\nnot json\n", 1, handler));
        assert_eq!(by_id(&answers, 1)["ok"], false);
        assert_eq!(by_id(&answers, 1)["kind"], "panic");
        assert_eq!(by_id(&answers, 1)["error"], "panic: declared rule blew up");
        assert_eq!(by_id(&answers, 2)["ok"], true);
        assert!(answers.iter().any(|a| a["id"].is_null() && a["kind"] == "request"));
    }

    /// A request the process cannot parse is answered under its own id, at
    /// once, and the lines after it are still served (the caller would
    /// otherwise wait out its timeout and kill the process).
    #[test]
    fn a_request_that_cannot_be_parsed_is_answered_under_its_id() {
        fn handler(_: &mut Observers, req: Request) -> Result<Value, Failure> {
            Ok(req.id)
        }
        let mut requests: Vec<u8> = Vec::new();
        // A field of the wrong type.
        requests.extend_from_slice(b"{\"id\":1,\"op\":\"x\",\"checkpoint\":[1]}\n");
        // A path with a lone surrogate escape: not for this parser, for Python's.
        requests.extend_from_slice(b"{\"id\":2,\"op\":\"x\",\"path\":\"/a/\\udcff\"}\n");
        // Bytes that are not UTF-8, which used to end the process.
        requests.extend_from_slice(b"{\"id\":3,\"op\":\"x\",\"path\":\"/a/\xff\"}\n");
        // Not JSON at all: no id to answer under.
        requests.extend_from_slice(b"{{{\n");
        requests.extend_from_slice(b"{\"id\":5,\"op\":\"x\"}\n");
        let answers = run_bytes(&requests, 1, handler);
        assert_eq!((by_id(&answers, 1)["ok"].clone(), by_id(&answers, 1)["kind"].clone()), (json!(false), json!("request")));
        assert_eq!((by_id(&answers, 2)["ok"].clone(), by_id(&answers, 2)["kind"].clone()), (json!(false), json!("python")));
        assert_eq!((by_id(&answers, 3)["ok"].clone(), by_id(&answers, 3)["kind"].clone()), (json!(false), json!("request")));
        assert!(answers.iter().any(|a| a["id"].is_null() && a["kind"] == "request"));
        assert_eq!(by_id(&answers, 5)["ok"], true, "the line after the bad ones is served");
        assert_eq!(answers.len(), 5);
    }

    #[test]
    fn observes_says_which_build_answered() {
        let answers = run("{\"id\":1,\"op\":\"observes\"}\n", 1, handle);
        let runtime = &by_id(&answers, 1)["result"][RUNTIME_KEY];
        assert_eq!(runtime["version"], env!("CARGO_PKG_VERSION"));
        let declarations = runtime["declarations"].as_str().unwrap();
        assert_eq!(declarations.len(), 16);
        assert_eq!(declarations, fingerprint(crate::registry::launch_json().as_bytes()));
        assert_ne!(declarations, fingerprint(b"other declarations"));
    }

    #[test]
    fn a_panic_costs_only_its_own_clis_reader_memory() {
        // A note stays in an observer until it is taken: it stands for
        // everything an observer remembers between calls.
        fn handler(observers: &mut Observers, req: Request) -> Result<Value, Failure> {
            match req.op.as_str() {
                "mark" => {
                    if let Some(AnyObserver::claude(observer)) = observers.get_mut("claude") {
                        observer.leave_note("mark");
                    }
                    if let Some(AnyObserver::codex(observer)) = observers.get_mut("codex") {
                        observer.leave_note("mark");
                    }
                    Ok(Value::Null)
                }
                "boom" => panic!("declared rule blew up"),
                _ => Ok(json!([observer(observers, "claude")?.take_notes().len(), observer(observers, "codex")?.take_notes().len()])),
            }
        }
        let answers = quietly(|| run("{\"id\":1,\"op\":\"mark\"}\n{\"id\":2,\"op\":\"boom\",\"vendor\":\"claude\"}\n{\"id\":3,\"op\":\"notes\"}\n", 1, handler));
        assert_eq!(by_id(&answers, 2)["kind"], "panic");
        assert_eq!(by_id(&answers, 3)["result"], json!([0, 1]), "claude's observer is new, codex's is the one it was");
    }

    #[test]
    fn a_slow_read_does_not_hold_up_another_file() {
        // Two lanes: the slow request is still running when the fast one answers.
        fn handler(_: &mut Observers, req: Request) -> Result<Value, Failure> {
            if req.path == "slow" {
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
            Ok(json!(req.path))
        }
        let slow = Request { id: json!(1), op: "x".into(), vendor: "v".into(), path: "slow".into(), ..empty() };
        let slow_lane = lane(&slow, 2);
        let fast_path = (0..64).map(|n| format!("fast-{n}")).find(|p| lane(&Request { path: p.clone(), vendor: "v".into(), ..empty() }, 2) != slow_lane).unwrap();
        let requests = format!("{{\"id\":1,\"op\":\"x\",\"vendor\":\"v\",\"path\":\"slow\"}}\n{{\"id\":2,\"op\":\"x\",\"vendor\":\"v\",\"path\":\"{fast_path}\"}}\n");
        let answers = run(&requests, 2, handler);
        let order: Vec<i64> = answers.iter().map(|a| a["id"].as_i64().unwrap()).collect();
        assert_eq!(order, [2, 1], "the fast file's answer is written first");
    }

    #[test]
    fn one_files_requests_are_answered_in_order() {
        fn handler(_: &mut Observers, req: Request) -> Result<Value, Failure> {
            Ok(req.id)
        }
        let requests: String = (0..50).map(|n| format!("{{\"id\":{n},\"op\":\"x\",\"vendor\":\"v\",\"path\":\"same\"}}\n")).collect();
        let order: Vec<i64> = run(&requests, 4, handler).iter().map(|a| a["id"].as_i64().unwrap()).collect();
        assert_eq!(order, (0..50).collect::<Vec<_>>());
    }

    fn empty() -> Request {
        serde_json::from_str("{\"op\":\"\"}").unwrap()
    }
}
