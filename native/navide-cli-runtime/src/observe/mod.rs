//! Observe: read a CLI's records and turn them into main's three outputs —
//! token usage (with a resumable checkpoint), activity events (with a
//! resumable walk state) and per-turn usage. Everything here is generic; a
//! vendor contributes only its `Observe` declaration and its `Ext` functions.
pub mod activity;
pub mod bag;
pub mod db;
pub mod file;
pub mod sqlite;
pub mod trace;
pub mod turns;
pub mod usage;

use crate::decl::{Observe, OtherFiles, Read, Seed, SlotInit, Turns, UsageRule, Vendor};
use crate::expr::{self, py_str, truthy, Scope, Slots};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fmt::Debug;
use std::path::{Path, PathBuf};

pub use activity::{ActivityState, TurnState, Walk};
pub use db::Sqlite;
pub use file::{Jsonl, TextLog, HAS_FILE_IDENTITY};

#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    /// A line that is not UTF-8 ended the walk (main raises there too).
    Decode { line: usize },
    /// A store this declaration does not describe (a SQLite table without a
    /// declared column, another store of the same CLI): the caller's own
    /// reader takes the call.
    Unsupported(String),
    /// A record this parser rejects and Python's `json` may read (`pyjson`:
    /// a lone surrogate escape, `NaN` and `Infinity`, a number out of range,
    /// nesting past 128 levels). Stepping over it would lose its tokens and
    /// events for good, so nothing is committed past it and the caller's own
    /// reader takes the whole call. That reader moves its checkpoint past the
    /// record, as main does (also if it turns out that Python rejects it:
    /// it then steps over it exactly as main does), so the next call starts
    /// after it and nothing loops. A record Python rejects too is not this
    /// error: main skips it, and so does the runtime.
    PythonReads(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Io(err) => write!(f, "io: {err}"),
            Error::Decode { line } => write!(f, "line {line} is not UTF-8"),
            Error::Unsupported(why) => write!(f, "unsupported store: {why}"),
            Error::PythonReads(why) => write!(f, "left to the Python reader: {why}"),
        }
    }
}

impl Error {
    /// A record at `where_` that this parser rejects (see `PythonReads`).
    pub(crate) fn unparsed(where_: impl std::fmt::Display) -> Self {
        Error::PythonReads(format!("{where_} is JSON this parser does not read"))
    }

    /// An error that hands the call to the caller's own reader: it says
    /// nothing about the store, and the caller reads the same bytes itself.
    pub fn is_handed_over(&self) -> bool {
        matches!(self, Error::Io(_) | Error::Unsupported(_) | Error::PythonReads(_))
    }
}

impl From<std::io::Error> for Error {
    fn from(err: std::io::Error) -> Self {
        Error::Io(err)
    }
}

/// main's `TokenUsage`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsageEvent {
    pub vendor: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cwd: String,
    pub session_id: String,
    pub file_path: String,
    pub dedup_key: String,
    pub timestamp: String,
    pub model: String,
    pub checkpoint: Map<String, Value>,
    pub raw: Map<String, Value>,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cli_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageRead {
    pub events: Vec<UsageEvent>,
    pub checkpoint: Map<String, Value>,
}

impl UsageRead {
    /// Nothing read: no events, the checkpoint as it was.
    pub(crate) fn unchanged(checkpoint: &Map<String, Value>) -> Self {
        UsageRead { events: Vec::new(), checkpoint: checkpoint.clone() }
    }
}

/// main's `ActivityEvent`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActivityEvent {
    pub vendor: String,
    pub event_type: String,
    pub cwd: String,
    pub session_id: String,
    pub file_path: String,
    pub dedup_key: String,
    pub timestamp: String,
    pub detail: String,
    pub text: String,
    /// `PromptText.full` of a user-prompt `text` (the chat mirror's longer copy).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub full: String,
}

/// main's `TurnCall`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TurnCall {
    pub ts: Option<String>,
    pub model: String,
    pub input: i64,
    pub cache_read: i64,
    pub cache_creation: i64,
    pub output: i64,
    pub cli_version: String,
}

/// main's `TurnUsage` (without `profile_id`, which a reader never sets).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TurnUsage {
    pub turn_index: usize,
    pub session_id: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub prompt_excerpt: String,
    pub input: i64,
    pub cache_read: i64,
    pub cache_creation: i64,
    pub output: i64,
    pub calls: Vec<TurnCall>,
    pub model_calls: Option<i64>,
    pub cli_version: String,
}

impl TurnUsage {
    pub(crate) fn new(session_id: String, started_at: Option<String>) -> Self {
        TurnUsage {
            turn_index: 0,
            session_id,
            started_at,
            ended_at: None,
            prompt_excerpt: String::new(),
            input: 0,
            cache_read: 0,
            cache_creation: 0,
            output: 0,
            calls: Vec::new(),
            model_calls: None,
            cli_version: String::new(),
        }
    }

    pub fn total(&self) -> i64 {
        self.input + self.cache_read + self.cache_creation + self.output
    }

    pub(crate) fn add_call(&mut self, call: TurnCall) {
        self.input += call.input;
        self.cache_read += call.cache_read;
        self.cache_creation += call.cache_creation;
        self.output += call.output;
        if !call.cli_version.is_empty() {
            self.cli_version = call.cli_version.clone();
        }
        self.calls.push(call);
    }
}

/// How records are stored: the format, its cursor and the checkpoint a usage
/// read keeps. The mechanics live in the implementation (`Jsonl`, `TextLog`,
/// `Sqlite`); a declaration picks one with `Vendor::Backend` and fills that
/// backend's own `Spec`, so the observer is compiled against exactly one
/// backend and no combination has to be ruled out at run time.
pub trait Backend<V: Vendor>: Sized + 'static {
    /// The backend's declaration: usage mode, cursor, queries.
    type Spec: Debug + Serialize + Sync + 'static;

    /// Usage after `checkpoint`. `full`: main's `parse_session_file` pass
    /// (every record from the top, an unbounded dedup set, no rewrite
    /// bookkeeping), used by inferred turns.
    fn usage(file: &File<'_, V>, checkpoint: &Map<String, Value>, full: bool, memo: &mut Memo) -> Result<UsageRead, Error>;

    /// Whether the declaration reads usage at all (inferred turns need it).
    fn has_usage(spec: &Self::Spec) -> bool;

    /// Every usage rule the declaration holds, whatever variant it is in.
    fn usage_rules(spec: &'static Self::Spec) -> Vec<&'static UsageRule<V>>;

    /// Feed the records past the cursor to the walk and move the cursor.
    fn walk(walk: &mut Walk<'_, V>, state: &mut ActivityState, memo: &mut Memo) -> Result<(), Error>;

    /// The cursor's part of the watcher's seen-keys bag.
    fn load(spec: &'static Self::Spec, bag: &[String], state: &mut ActivityState);
    fn store(spec: &'static Self::Spec, state: &ActivityState, bag: &mut Vec<String>);

    /// Whether `exact_turns` is implemented.
    const EXACT_TURNS: bool = false;

    /// Turns the transcript names itself; only a line transcript has them.
    fn exact_turns(_file: &File<'_, V>, _turns: &'static crate::decl::ExactTurns<V>, _session_id: &str) -> Result<Vec<TurnUsage>, Error> {
        Err(Error::Unsupported("exact turns need a line transcript".to_owned()))
    }
}

/// One transcript being read, with its declaration.
pub struct File<'a, V: Vendor> {
    pub path: &'a Path,
    pub spec: &'static Observe<V>,
}

impl<'a, V: Vendor> File<'a, V> {
    pub fn vendor(&self) -> &'static str {
        V::CLI.key
    }

    pub fn records(&self) -> &'static <V::Backend as Backend<V>>::Spec {
        &self.spec.records
    }

    pub fn path_text(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }

    /// The file's slots before any record: the declared initial values, with
    /// the section's own in place of the file's.
    pub fn slots(&self, section: &'static [Seed<V>]) -> Result<Slots<V>, Error> {
        let mut slots = Slots::default();
        for slot in self.spec.slots.iter().filter(|s| !section.iter().any(|o| o.slot == s.slot)).chain(section) {
            slots.set(slot.slot, init(&slot.init, self.path)?);
        }
        Ok(slots)
    }
}

/// What an observer keeps in memory between calls, as main's reader objects
/// do: where each file's last line walk stopped, the partition labels it has
/// resolved, and the notes and read outcomes of the call in progress.
#[derive(Default)]
pub struct Memo {
    pub(crate) resume: HashMap<PathBuf, file::LineResume>,
    pub(crate) labels: HashMap<(PathBuf, String), String>,
    pub(crate) notes: Vec<Note>,
    pub(crate) reads: Vec<Read>,
}

/// Something main's reader logs as a warning while it reads. The seam logs
/// it through the reader's own logger, once per reader and `kind` (main
/// warns once per reader, whatever the store or session).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Note {
    pub kind: &'static str,
    pub text: String,
}

impl Memo {
    pub(crate) fn note(&mut self, kind: &'static str, text: String) {
        if !self.notes.iter().any(|note| note.kind == kind) {
            self.notes.push(Note { kind, text });
        }
    }
}

/// One CLI's observer.
pub struct Observer<V: Vendor> {
    spec: &'static Observe<V>,
    memo: Memo,
    clock: Option<f64>,
}

impl<V: Vendor> Observer<V> {
    /// `None` when the CLI declares no observable records.
    pub fn new() -> Option<Self> {
        Some(Observer { spec: V::OBSERVE?, memo: Memo::default(), clock: None })
    }

    pub fn key(&self) -> &'static str {
        V::CLI.key
    }

    pub fn spec(&self) -> &'static Observe<V> {
        self.spec
    }

    /// Pin "now" (seconds since the epoch) for idle flushes; `None` = the
    /// system clock. The backend passes its own clock so both readers agree.
    pub fn set_clock(&mut self, now: Option<f64>) {
        self.clock = now;
    }

    fn now(&self) -> f64 {
        self.clock.unwrap_or_else(|| {
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64())
        })
    }

    /// The notes the calls since the last take left (main's reader would
    /// have logged them).
    pub fn take_notes(&mut self) -> Vec<Note> {
        std::mem::take(&mut self.memo.notes)
    }

    #[cfg(test)]
    pub(crate) fn leave_note(&mut self, kind: &'static str) {
        self.memo.note(kind, String::new());
    }

    /// What the last call's reads have to tell the registry main's reader
    /// keeps (`decl::Read`); empty after a call that failed.
    pub fn take_reads(&mut self) -> Vec<Read> {
        std::mem::take(&mut self.memo.reads)
    }

    fn named(&self, path: &Path) -> bool {
        self.spec.file_name.is_none_or(|name| path.file_name().and_then(|n| n.to_str()) == Some(name))
    }

    /// `Ok(false)`: not a transcript, nothing to read.
    fn accepts(&self, path: &Path) -> Result<bool, Error> {
        if self.named(path) && V::accepts(path) {
            return Ok(true);
        }
        match self.spec.other_files {
            OtherFiles::Empty => Ok(false),
            OtherFiles::Unsupported => Err(Error::Unsupported(format!("{} is not the declared store", path.display()))),
        }
    }

    /// A call the caller's own reader takes over (it could not be read, or
    /// is not this declaration's) says nothing: that reader makes the same
    /// reads and says it itself. A decode error still answers.
    fn settled<T>(&mut self, result: Result<T, Error>) -> Result<T, Error> {
        if result.as_ref().is_err_and(Error::is_handed_over) {
            self.memo.reads.clear();
            self.memo.notes.clear();
        }
        result
    }

    pub fn usage(&mut self, path: &Path, checkpoint: &Map<String, Value>) -> Result<UsageRead, Error> {
        self.memo.reads.clear();
        if !self.accepts(path)? {
            return Ok(UsageRead::unchanged(checkpoint));
        }
        let read = V::Backend::usage(&File { path, spec: self.spec }, checkpoint, false, &mut self.memo);
        self.settled(read)
    }

    pub fn activity(&mut self, path: &Path, state: &mut ActivityState) -> Result<Vec<ActivityEvent>, Error> {
        self.memo.reads.clear();
        if !self.accepts(path)? {
            return Ok(Vec::new());
        }
        let now = self.now();
        let events = activity::walk(&File { path, spec: self.spec }, state, &mut self.memo, now);
        self.settled(events)
    }

    /// `activity` over the watcher's seen-keys bag: the state is read from it
    /// and written back to it (also when a decode error ends the walk, as
    /// main's `finally` does; not when the file cannot be read).
    pub fn activity_bag(&mut self, path: &Path, bag: &mut Vec<String>) -> Result<Vec<ActivityEvent>, Error> {
        let mut state = bag::load(self.spec, bag);
        let result = self.activity(path, &mut state);
        if !result.as_ref().is_err_and(Error::is_handed_over) {
            bag::store(self.spec, &state, bag);
        }
        result
    }

    /// Per-turn usage. The file's name is checked as everywhere; main's
    /// whole-file usage pass behind an inferred cut does not apply the
    /// narrower `Vendor::accepts`, its activity pass does.
    pub fn turns(&mut self, path: &Path, session_id: &str) -> Result<Vec<TurnUsage>, Error> {
        if !self.named(path) {
            return match self.spec.other_files {
                OtherFiles::Empty => Ok(Vec::new()),
                OtherFiles::Unsupported => Err(Error::Unsupported(format!("{} is not the declared store", path.display()))),
            };
        }
        self.memo.reads.clear();
        let file = File { path, spec: self.spec };
        let turns = match &self.spec.turns {
            Turns::None => Ok(Vec::new()),
            Turns::Exact(exact) => V::Backend::exact_turns(&file, exact, session_id),
            Turns::Inferred => self.inferred_turns(&file, session_id),
        };
        self.settled(turns)
    }

    fn inferred_turns(&mut self, file: &File<'_, V>, session_id: &str) -> Result<Vec<TurnUsage>, Error> {
        let usage = V::Backend::usage(file, &Map::new(), true, &mut self.memo)?.events;
        let activity = if V::accepts(file.path) {
            let now = self.now();
            // A scratch walk: nothing it learns is kept.
            let mut scratch = Memo::default();
            activity::walk(file, &mut ActivityState::default(), &mut scratch, now)?
        } else {
            Vec::new()
        };
        Ok(turns::inferred(&usage, &activity, session_id))
    }
}

pub(crate) fn file_name(path: &Path) -> String {
    path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_owned()
}

/// The `n`-th directory above the file (1 = its own directory).
pub fn nth_dir(path: &Path, n: usize) -> Option<&Path> {
    path.ancestors().nth(n)
}

/// The name of the `n`-th directory above the file ("" when there is none).
pub fn dir_name(path: &Path, n: usize) -> String {
    nth_dir(path, n).map(file_name).unwrap_or_default()
}

/// A slot's value before any record. Only a header line this parser rejects
/// is an error (`PythonReads`); a header that cannot be read is empty.
fn init<V: Vendor>(init_spec: &SlotInit<V>, path: &Path) -> Result<String, Error> {
    Ok(match init_spec {
        SlotInit::Empty => String::new(),
        SlotInit::FileStem => path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_owned(),
        SlotInit::DirName(n) => dir_name(path, *n),
        SlotInit::Header { lines, when, field, first_line } => {
            let empty = Slots::<V>::default();
            let mut found = String::new();
            let read = file::all_lines(path, *lines, false, |line, stripped, value| {
                if stripped.is_empty() {
                    return true;
                }
                match value.filter(|v| v.is_object()) {
                    Some(record) => {
                        let scope = Scope { line, ..Scope::of(record, &empty) };
                        if expr::pred(when, &scope) {
                            found = expr::text(field, &scope);
                            return false;
                        }
                        !first_line
                    }
                    None => !first_line,
                }
            });
            if let Err(err @ Error::PythonReads(_)) = read {
                return Err(err);
            }
            found
        }
        SlotInit::SidecarJson { up, file, keys } => nth_dir(path, *up)
            .and_then(|dir| std::fs::read_to_string(dir.join(file)).ok())
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| {
                let object = value.as_object()?;
                keys.iter().filter_map(|k| object.get(*k)).find(|v| truthy(v)).map(py_str)
            })
            .unwrap_or_default(),
        SlotInit::FirstOf(options) => {
            let mut first = String::new();
            for option in *options {
                first = init(option, path)?;
                if !first.is_empty() {
                    break;
                }
            }
            first
        }
        SlotInit::Ext(ext) => V::init(*ext, path),
    })
}
