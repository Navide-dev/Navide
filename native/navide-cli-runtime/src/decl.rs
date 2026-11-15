//! The declaration schema: everything one CLI is, as typed static data.
//!
//! A vendor file under `src/vendors/` implements `Vendor` for one marker
//! type. The core is generic over that type (`Observer<V>`), so a vendor is
//! compiled into its own copy of the engine: no vendor is looked up by name
//! and no call goes through a table.
//!
//! What is shared lives here as data the core runs: rules, slots, the
//! inferred-turn tracker's operations, and a small record-access language
//! (`Pred`, `Text`, `Num`) holding only what two or more CLIs use, or what is
//! plainly generic (constants, slots, boolean and first-of combinators, the
//! walk's line and offset). A value only one CLI reads its own way is an
//! `Ext` of that CLI: a typed id, evaluated by the vendor's pure function
//! (`Vendor::text`, `num`, `pred`), with the record and the slots as input.
//!
//! How records are *stored* (the file or database format, its cursor, the
//! checkpoint a usage read keeps) is a `Backend`, and a new store shape is a
//! change to the core by design: that is where tailing, state and
//! checkpoints live. Each backend has its own declaration type, so a
//! combination the core cannot run (a row cursor over a text file) cannot be
//! written down.
use crate::expr::Scope;
use crate::observe::Backend;
use serde::Serialize;
use serde_json::Value;
use std::fmt::Debug;

pub type Str = &'static str;

/// One CLI: its launch and resume data, and (when its records are declared)
/// how they are observed.
pub trait Vendor: Sized + Debug + 'static {
    /// The per-file values its rules keep (`slots!`).
    type Slot: SlotKey;
    /// The values only this CLI extracts (`NoExt` when it has none).
    type Ext: Copy + Debug + Serialize + Send + Sync + 'static;
    /// How its records are stored.
    type Backend: Backend<Self>;

    const CLI: &'static Cli;
    /// `None`: not declared (no transcript, or its records are not described
    /// yet); the backend keeps main's Python reader for it.
    const OBSERVE: Option<&'static Observe<Self>>;

    /// This CLI's own text extraction. Pure: the record, the slots and the
    /// walk's facts in, the value out.
    fn text(_ext: Self::Ext, _scope: &Scope<'_, Self>) -> String {
        String::new()
    }
    /// Its own number (`None`: this record carries no reading).
    fn num(_ext: Self::Ext, _scope: &Scope<'_, Self>) -> Option<i64> {
        None
    }
    /// Its own test.
    fn pred(_ext: Self::Ext, _scope: &Scope<'_, Self>) -> bool {
        false
    }
    /// Its own slot initialiser, from the transcript's path. The one place a
    /// vendor function may touch the file system, and each use says why.
    fn init(_ext: Self::Ext, _path: &std::path::Path) -> String {
        String::new()
    }
    /// Narrows `Observe::file_name`: is this file one of its transcripts?
    fn accepts(_path: &std::path::Path) -> bool {
        true
    }
    /// Which of the declared variants this store holds (`SqlUsage::OneOf`,
    /// `SqlWalk::OneOf`): `store` runs one query and returns its rows, `None`
    /// when it cannot be read this cycle. Read-only, and only through `store`.
    fn probe<S: FnMut(&str) -> Option<Vec<Value>>>(_ext: Self::Ext, _store: &mut S) -> Probed {
        Probed { pick: Some(0), read: None }
    }
}

/// What a probe found.
#[derive(Debug)]
pub struct Probed {
    /// The variant to read; `None`: none of them, nothing is read.
    pub pick: Option<usize>,
    /// What the probe has to say about the store, for the caller's reader.
    pub read: Option<Read>,
}

/// The outcome of one read that main's reader keeps a record of (its
/// read-problem registry, which the CLI's status shows): the seam applies it
/// to that registry, so a store the runtime reads is disclosed, and cleared,
/// exactly as one main's reader reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Read {
    /// The registry's name for the read.
    pub key: Str,
    /// `None`: the read worked.
    pub problem: Option<Problem>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub status: Str,
    pub reason: Str,
    pub detail: String,
}

/// On the wire: `{"key", "ok": true}`, or `{"key", "status", "reason", "detail"}`.
impl Serialize for Read {
    fn serialize<S: serde::Serializer>(&self, out: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = out.serialize_map(None)?;
        map.serialize_entry("key", self.key)?;
        match &self.problem {
            None => map.serialize_entry("ok", &true)?,
            Some(problem) => {
                map.serialize_entry("status", problem.status)?;
                map.serialize_entry("reason", problem.reason)?;
                map.serialize_entry("detail", &problem.detail)?;
            }
        }
        map.end()
    }
}

/// A typed slot handle: a misspelt slot does not compile, and a lookup is an
/// array index.
pub trait SlotKey: Copy + Eq + Debug + Serialize + Send + Sync + 'static {
    const ALL: &'static [Self];
    fn index(self) -> usize;
    /// The key a persisted slot has in a checkpoint.
    fn name(self) -> Str;
}

/// Declares a vendor's `Slot` enum: `slots! { Cwd = "cwd", Reply = "reply" }`.
#[macro_export]
macro_rules! slots {
    ($($variant:ident = $name:literal),* $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum Slot { $($variant),* }
        impl $crate::decl::SlotKey for Slot {
            const ALL: &'static [Self] = &[$(Slot::$variant),*];
            fn index(self) -> usize {
                self as usize
            }
            fn name(self) -> &'static str {
                match self { $(Slot::$variant => $name),* }
            }
        }
        impl $crate::serde::Serialize for Slot {
            fn serialize<S: $crate::serde::Serializer>(&self, out: S) -> Result<S::Ok, S::Error> {
                out.serialize_str($crate::decl::SlotKey::name(*self))
            }
        }
    };
}

pub use crate::slots;

/// A CLI that is launched and resumed but not observed here.
#[macro_export]
macro_rules! unobserved {
    ($cli:ident) => {
        #[derive(Debug)]
        pub struct V;
        impl $crate::decl::Vendor for V {
            type Slot = $crate::decl::NoSlot;
            type Ext = $crate::decl::NoExt;
            type Backend = $crate::observe::file::Jsonl;
            const CLI: &'static $crate::decl::Cli = &$cli;
            const OBSERVE: Option<&'static $crate::decl::Observe<Self>> = None;
        }
    };
}

/// The slots of a CLI that keeps none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum NoSlot {}

impl SlotKey for NoSlot {
    const ALL: &'static [Self] = &[];
    fn index(self) -> usize {
        match self {}
    }
    fn name(self) -> Str {
        match self {}
    }
}

/// The extractions of a CLI the shared vocabulary covers.
#[derive(Debug, Clone, Copy, Serialize)]
pub enum NoExt {}

#[derive(Debug, Serialize)]
pub struct Cli {
    pub key: Str,
    pub label: Str,
    pub kind: Kind,
    pub order: Order,
    pub launch: Launch,
    pub resume: Resume,
    /// Byte(s) that interrupt the CLI in its PTY.
    pub interrupt: &'static [u8],
}

/// Where a CLI sits in the two lists the app builds from the declarations,
/// ascending. No two CLIs share a number (`tests/declarations.rs`), and the
/// numbers leave gaps, so a new CLI takes a free one and no other file
/// changes.
#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
pub struct Order {
    /// The frontend's agent specs: the spawn menus and the settings lists.
    pub menu: u16,
    /// The backend's vendor registry. Its order reaches callers that iterate
    /// it (install detection, capability maps), so it is declared, not
    /// derived from the key.
    pub registry: u16,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Cli,
    Agent,
}

// ---- launch -----------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct Launch {
    pub program: Str,
    pub base_args: &'static [Str],
    /// Appended when the pane runs unattended (YOLO). Empty: the CLI has none.
    pub yolo_args: &'static [Str],
    /// Arguments that name the model; `{}` is the value. `None`: refused.
    pub model: Option<&'static [Str]>,
    /// Arguments that name the reasoning effort; `{}` is the value.
    pub effort: Option<&'static [Str]>,
    /// Closed effort vocabulary; empty = any value is passed through.
    pub efforts: &'static [Str],
    /// Added only when neither the request nor the inherited env has the name.
    pub env_defaults: &'static [(Str, Str)],
    /// Names that relocate the CLI's home: stripped from inherited env.
    pub env_strip: &'static [Str],
}

impl Launch {
    /// `program` alone: no arguments, no model or effort flag, no env.
    pub const fn of(program: Str) -> Launch {
        Launch { program, base_args: &[], yolo_args: &[], model: None, effort: None, efforts: &[], env_defaults: &[], env_strip: &[] }
    }
}

// ---- resume -----------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct Resume {
    /// Resume arguments after the program; `{id}` is the session id.
    pub args: Option<&'static [Str]>,
    /// How a saved command names the session it resumes.
    pub parse: Option<ResumeParse>,
}

impl Resume {
    /// The CLI cannot resume by id.
    pub const NONE: Resume = Resume { args: None, parse: None };
}

#[derive(Debug, Serialize)]
pub struct ResumeParse {
    /// Accepted first tokens.
    pub programs: &'static [Str],
    pub tokens: Tokens,
    /// Token 1 must be one of these (a subcommand); empty = no subcommand.
    pub subcommand: &'static [Str],
    /// The id follows the subcommand directly (`codex resume <id>`).
    pub id_after_subcommand: bool,
    pub flags: &'static [Str],
    /// `--flag=value` is accepted too, with a value of this shape.
    pub joined: Option<ValueShape>,
    /// Which occurrence wins when a flag repeats. `Whitespace` picks among
    /// the occurrences whose value has the right shape (main's regexes
    /// backtrack past a bad one); `Literal` lets the first occurrence decide.
    pub pick: Pick,
    pub value: ValueShape,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
pub enum Tokens {
    /// Whitespace split of the command's last element (a shell wrapper's script).
    Whitespace,
    /// A literal invocation only: known shell wrappers unwrapped, no shell
    /// metacharacters, shell-quoted split, scanning stops at `--`.
    Literal,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
pub enum Pick {
    First,
    Last,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
pub enum ValueShape {
    Any,
    /// Must not start with `-`.
    NoDash,
    /// A canonical hyphenated UUID in any case; the id is its lowercase form.
    Uuid,
    /// Starts with this prefix and has no surrounding whitespace.
    Prefix(Str),
}

// ---- observe ----------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct Observe<V: Vendor> {
    /// The transcript's exact file name (`None`: any file the caller hands
    /// over; finding a CLI's transcripts stays the backend's scan).
    /// `Vendor::accepts` narrows it further.
    pub file_name: Option<Str>,
    /// What a file that is not a transcript answers.
    pub other_files: OtherFiles,
    /// Slots that start with a value (every other slot starts empty).
    pub slots: &'static [Seed<V>],
    /// The slots an event's cwd and session id are read from.
    pub cwd: Option<V::Slot>,
    pub session: Option<V::Slot>,
    /// The form the cwd reaches the application in. The runtime hands it on
    /// as written; the seam applies the form.
    pub cwd_form: Form,
    /// The backend's own declaration: the usage mode, the cursor, the queries.
    pub records: <V::Backend as Backend<V>>::Spec,
    pub activity: Activity<V>,
    pub turns: Turns<V>,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
pub enum OtherFiles {
    /// Nothing to read: no events, the checkpoint as it was.
    Empty,
    /// Another store of the same CLI, which this declaration does not
    /// describe: `Error::Unsupported`, so the caller's own reader reads it.
    Unsupported,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Form {
    /// As the transcript wrote it.
    Written,
    /// Unicode NFC (a path typed on macOS may be recorded decomposed).
    Nfc,
}

/// A slot's first value.
#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct Seed<V: Vendor> {
    pub slot: V::Slot,
    pub init: SlotInit<V>,
}

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub enum SlotInit<V: Vendor> {
    Empty,
    /// File name without extension.
    FileStem,
    /// Name of the `n`-th directory above the file (1 = its own directory).
    DirName(usize),
    /// `field` of the first JSON record matching `when` within the first
    /// `lines` lines (blank and malformed lines count; 0 = no limit). With
    /// `first_line`, only the first non-blank line is considered at all.
    Header { lines: usize, when: Pred<V>, field: Text<V>, first_line: bool },
    /// A JSON object file in the `up`-th directory above the transcript
    /// (1 = its own directory); the first key with a truthy value wins.
    SidecarJson { up: usize, file: Str, keys: &'static [Str] },
    /// First non-empty of several initialisers.
    FirstOf(&'static [SlotInit<V>]),
    /// The vendor's own (`Vendor::init`).
    Ext(V::Ext),
}

// ---- record access ----------------------------------------------------------

/// A path into a JSON record: object keys, read left to right.
pub type Path = &'static [Str];

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub enum Pred<V: Vendor> {
    True,
    /// The value at the path is this string.
    Eq(Path, Str),
    In(Path, &'static [Str]),
    /// The key exists (any value, `null` included).
    Has(Path),
    /// Python truthiness of the value.
    Truthy(Path),
    IsObject(Path),
    IsList(Path),
    IsString(Path),
    /// A test on computed text.
    Text(Text<V>, StrTest),
    /// Some element of the list at the path satisfies the predicate.
    AnyItem(Path, &'static Pred<V>),
    /// A slot is non-empty.
    SlotSet(V::Slot),
    All(&'static [Pred<V>]),
    Any(&'static [Pred<V>]),
    Not(&'static Pred<V>),
    /// The vendor's own (`Vendor::pred`).
    Ext(V::Ext),
}

#[derive(Debug, Serialize, Clone, Copy)]
pub enum StrTest {
    Eq(Str),
    In(&'static [Str]),
    StartsWith(Str),
    Contains(Str),
    NonEmpty,
}

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub enum Text<V: Vendor> {
    Lit(Str),
    /// Python `str(value or "")`.
    Py(Path),
    /// The value only if it is a string, else "".
    Str(Path),
    Slot(V::Slot),
    /// First non-empty.
    FirstOf(&'static [Text<V>]),
    Concat(&'static [Text<V>]),
    /// `join_text_blocks`: a string as is, else the `text` of blocks of this type.
    Blocks(Path, Str),
    /// Join `item` evaluated per element of the list at `list` (elements that
    /// fail `filter` skipped), with `sep`; empty results are kept only when
    /// `keep_empty`.
    Join { list: Path, filter: &'static Pred<V>, item: &'static Text<V>, sep: Str, keep_empty: bool },
    /// Values of `<tag>…</tag>` occurrences (non-empty, no `<`), joined by `\n`.
    TagValues(&'static Text<V>, Str),
    /// `user_prompt_text`: stripped, "" for `<`-wrappers, capped at 500 chars.
    UserPrompt(&'static Text<V>),
    /// Stripped.
    Strip(&'static Text<V>),
    /// Over `n` chars: the first and last halves around `\n…\n`.
    Cap(&'static Text<V>, usize),
    If(&'static Pred<V>, &'static Text<V>),
    /// A number rendered as decimal.
    Num(&'static Num<V>),
    /// 1-based line number of the record.
    Line,
    /// Byte offset just past the record.
    Offset,
    /// The running input and output totals a cumulative or snapshot usage
    /// read is crediting (decimal).
    TotalIn,
    TotalOut,
    /// The vendor's own (`Vendor::text`).
    Ext(V::Ext),
}

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub enum Num<V: Vendor> {
    Zero,
    /// Python `max(0, int(v))`, 0 when not a number.
    Of(Path),
    Sum(&'static [Num<V>]),
    /// The vendor's own (`Vendor::num`).
    Ext(V::Ext),
}

// ---- usage ------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct UsageRule<V: Vendor> {
    pub when: Pred<V>,
    /// Slot updates this record makes (before any reading).
    pub effects: &'static [Effect<V>],
    pub reading: Option<Reading<V>>,
}

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct Reading<V: Vendor> {
    pub input: Num<V>,
    pub output: Num<V>,
    pub cache_read: Num<V>,
    pub cache_creation: Num<V>,
    /// Dedup key; an empty key means "not a usage record" when `key_required`.
    pub key: Text<V>,
    pub key_required: bool,
    /// Key that is never valid (a key made of separators only).
    pub key_invalid: Str,
    pub model: Text<V>,
    pub timestamp: Text<V>,
    pub cli_version: Text<V>,
    pub cwd: Text<V>,
    pub session_id: Text<V>,
    /// Extra values for the cost ledger: `(nested key path, value)`.
    pub raw: &'static [(Path, RawValue<V>)],
}

impl<V: Vendor> Reading<V> {
    /// A reading of `input` and `output` under `key`: no cache split, no
    /// model, version, stamp, cwd or session, nothing for the ledger.
    pub const fn of(input: Num<V>, output: Num<V>, key: Text<V>) -> Self {
        Reading {
            input,
            output,
            cache_read: Num::Zero,
            cache_creation: Num::Zero,
            key,
            key_required: false,
            key_invalid: "",
            model: Text::Lit(""),
            timestamp: Text::Lit(""),
            cli_version: Text::Lit(""),
            cwd: Text::Lit(""),
            session_id: Text::Lit(""),
            raw: &[],
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub enum RawValue<V: Vendor> {
    Num(Num<V>),
    Text(Text<V>),
}

// ---- activity ---------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct Activity<V: Vendor> {
    /// Slots that start a walk with another value than the file's.
    pub slots: &'static [Seed<V>],
    pub rules: &'static [Rule<V>],
    /// Close the latest inferred turn once the transcript has been quiet.
    pub idle: Option<Idle>,
    /// How the inferred-turn tracker stamps a closed turn.
    pub turn_stamp: TurnStamp,
    /// Slot holding the reply text a tracker-closed turn carries.
    pub turn_text: Option<V::Slot>,
    /// Slots kept across walks (all others are re-initialised per walk), each
    /// with the key it has in the watcher's per-file seen-keys bag. The key
    /// formats are main's readers', so the bag means the same thing whichever
    /// reader wrote it; the line mark is always main's `act_hw::N`.
    pub kept: &'static [Kept<V>],
    /// The inferred-turn tracker as one JSON key: `{idx, flushed, ts}` for a
    /// `TurnStamp::Text` tracker, `{idx, last_ms, flushed[, cancelled]}` for `Millis`.
    pub turn_key: Option<TurnKey>,
}

impl<V: Vendor> Activity<V> {
    /// Rules only: nothing kept between walks, no inferred-turn tracker.
    pub const fn rules(rules: &'static [Rule<V>]) -> Self {
        Activity { slots: &[], rules, idle: None, turn_stamp: TurnStamp::Text, turn_text: None, kept: &[], turn_key: None }
    }
}

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct Kept<V: Vendor> {
    pub slot: V::Slot,
    pub prefix: Str,
    pub form: KeptForm,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
pub enum KeptForm {
    /// `prefix + text`, rewritten every walk; no key while empty.
    Text,
    /// `prefix + text`, rewritten only when the walk wrote the slot (even
    /// with the same value); an empty value keeps its bare-prefix key.
    TextOnChange,
    /// `prefix + json(text)`; no key while empty.
    JsonText,
}

#[derive(Debug, Serialize)]
pub struct TurnKey {
    pub prefix: Str,
    /// `json.dumps(separators=(",", ":"))` instead of the default `", "` / `": "`.
    pub compact: bool,
    /// No tracker is stored as `prefix + "null"` (else: no key).
    pub keep_null: bool,
}

#[derive(Debug, Serialize)]
pub struct Idle {
    pub after_ms: u64,
    pub clock: Clock,
    pub detail: Str,
}

#[derive(Debug, Serialize, Clone, Copy)]
pub enum Clock {
    /// Time since the file's last write.
    FileMtime,
    /// Time since the turn's last recorded epoch-ms.
    TurnMillis,
}

#[derive(Debug, Serialize, Clone, Copy)]
pub enum TurnStamp {
    Text,
    Millis,
}

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct Rule<V: Vendor> {
    pub when: Pred<V>,
    pub effects: &'static [Effect<V>],
}

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub enum Effect<V: Vendor> {
    Emit(Emit<V>),
    Set(V::Slot, Text<V>),
    SetIfNonEmpty(V::Slot, Text<V>),
    /// Append, capped like `Text::Cap`.
    Append(V::Slot, Text<V>, usize),
    Turn(TurnOp<V>),
    When(&'static Pred<V>, &'static [Effect<V>]),
    /// Stop evaluating rules for this record.
    Stop,
}

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct Emit<V: Vendor> {
    pub kind: EventKind,
    pub key: Text<V>,
    pub detail: Text<V>,
    pub text: Text<V>,
    pub timestamp: Text<V>,
    /// Session id override (per-record ids); `None` = the file's.
    pub session: Option<Text<V>>,
    /// Emit only when `text` is non-empty.
    pub require_text: bool,
}

impl<V: Vendor> Emit<V> {
    pub const fn new(kind: EventKind, key: Text<V>, detail: Text<V>, text: Text<V>, timestamp: Text<V>) -> Self {
        Emit { kind, key, detail, text, timestamp, session: None, require_text: false }
    }

    /// An `agent_active` event.
    pub const fn active(key: Text<V>, detail: Text<V>, text: Text<V>, timestamp: Text<V>) -> Self {
        Self::new(EventKind::AgentActive, key, detail, text, timestamp)
    }

    /// A `turn_complete` event.
    pub const fn done(key: Text<V>, detail: Text<V>, text: Text<V>, timestamp: Text<V>) -> Self {
        Self::new(EventKind::TurnComplete, key, detail, text, timestamp)
    }

    /// With a per-record session id.
    pub const fn of_session(self, session: Text<V>) -> Self {
        let Emit { kind, key, detail, text, timestamp, session: _, require_text } = self;
        Emit { kind, key, detail, text, timestamp, session: Some(session), require_text }
    }

    /// Emitted only when its text is non-empty.
    pub const fn with_text(self) -> Self {
        let Emit { kind, key, detail, text, timestamp, session, require_text: _ } = self;
        Emit { kind, key, detail, text, timestamp, session, require_text: true }
    }

    pub const fn effect(self) -> Effect<V> {
        Effect::Emit(self)
    }

    /// The event, then no further rule for the record.
    pub const fn last(self) -> [Effect<V>; 2] {
        [Effect::Emit(self), Effect::Stop]
    }
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    AgentActive,
    TurnComplete,
    SubagentTurnEnd,
}

/// Operations on the core's inferred-turn tracker (`{idx, ts, ms, flushed, cancelled}`).
#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub enum TurnOp<V: Vendor> {
    /// Close the open turn (emitting `boundary`), then open the next one at this record.
    Open { boundary: Str, ts: Text<V>, ms: Num<V> },
    /// Open the next turn only when none is open.
    EnsureOpen { ts: Text<V>, ms: Num<V> },
    /// Re-stamp the open turn with this record's time (text replaces, ms takes the max).
    Touch { ts: Option<Text<V>>, ms: Option<Num<V>> },
    /// Close the open turn with `detail` (stamped with the max of its ms and the record's).
    Close { detail: Str, ms: Option<Num<V>> },
    /// Close (if open) with `detail` and mark the turn cancelled.
    Cancel { detail: Str, ms: Option<Num<V>> },
}

// ---- turns ------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub enum Turns<V: Vendor> {
    /// No per-turn usage (no token records, or none a turn can be cut from).
    None,
    /// Usage cut on `turn_complete` timestamps (main's base reader).
    Inferred,
    /// The transcript names its own turns.
    Exact(&'static ExactTurns<V>),
}

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct ExactTurns<V: Vendor> {
    /// Slots that start the pass with another value than the file's.
    pub slots: &'static [Seed<V>],
    pub filter: SessionFilter<V>,
    /// Slot updates made while walking (they run before `skip`).
    pub effects: &'static [Rule<V>],
    /// Records skipped before any turn rule.
    pub skip: Option<Pred<V>>,
    pub open: Option<TurnOpen<V>>,
    pub call: TurnCall<V>,
    pub close: Option<TurnClose<V>>,
    /// The whole file must be UTF-8 (main opens it strictly and raises);
    /// else a line that is not is skipped.
    pub strict_utf8: bool,
}

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub enum SessionFilter<V: Vendor> {
    /// A requested session id is ignored.
    Ignore,
    /// A requested id must be the file's session slot or its stem.
    File,
    /// Records whose own session id differs are skipped.
    Record(Text<V>),
}

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct TurnOpen<V: Vendor> {
    pub when: Pred<V>,
    pub mode: OpenMode<V>,
    pub prompt: Text<V>,
    pub merge: PromptMerge,
    pub started: Text<V>,
}

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub enum OpenMode<V: Vendor> {
    /// One turn per key; a later record with the same key rejoins it.
    ByKey(Text<V>),
    /// Every matching record starts a new turn.
    Each,
    /// Join the open turn; start one when none is open.
    Join,
}

#[derive(Debug, Serialize, Clone, Copy)]
pub enum PromptMerge {
    /// `turn_excerpt` of the prompt.
    Excerpt,
    /// `merge_prompt_excerpt`: the first typed prompt wins.
    Merge,
}

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct TurnCall<V: Vendor> {
    pub when: Pred<V>,
    /// One call per entry of an object; `None`: one call, read off the record.
    pub each: Option<Each>,
    /// Paths are relative to the entry when iterating.
    pub input: Num<V>,
    pub cache_read: Num<V>,
    pub cache_creation: Num<V>,
    pub output: Num<V>,
    /// `input` counts the cache parts too: subtract them.
    pub input_includes_cache: bool,
    /// The counters are running totals: calls are their deltas.
    pub cumulative: bool,
    /// A call whose counters are all zero is not a call.
    pub skip_zero: bool,
    pub key: Option<Text<V>>,
    pub key_invalid: Str,
    pub model: Text<V>,
    pub ts: Text<V>,
    pub cli_version: Text<V>,
    pub orphan: Orphan,
}

#[derive(Debug, Serialize)]
pub struct Each {
    /// The object whose entries are calls (the entry's key is `Scope::entry_key`).
    pub map: Path,
    /// Used as the single entry, with an empty key, when `map` is missing or empty.
    pub fallback: Path,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
pub enum Orphan {
    /// A call before any open turn is dropped.
    Drop,
    /// Until the first open, each call is its own turn.
    OwnTurnUntilFirstOpen,
    /// The call is attached to the turn its close record makes.
    ToClose,
}

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct TurnClose<V: Vendor> {
    pub when: Pred<V>,
    pub ended: Text<V>,
    pub session: Option<Text<V>>,
    pub model_calls: Option<Num<V>>,
    /// Drop a closed turn whose four counters are all zero.
    pub drop_empty: bool,
}

// ---- records: one declaration type per backend ------------------------------

pub use crate::observe::{Jsonl, Sqlite, TextLog};

/// `Jsonl`: one transcript per session, a JSON object per line.
#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct JsonlRecords<V: Vendor> {
    pub usage: Option<FileUsage<V>>,
    pub cursor: LineCursor,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
pub enum LineCursor {
    /// Dense line high-water mark (resumable by byte offset).
    Lines,
    /// A byte cursor over complete records (rewrites restart it), kept in the
    /// bag as `key + json(checkpoint, sort_keys)`.
    Bytes { key: Str },
}

/// `TextLog`: one plain-text transcript per session (Markdown history). Each
/// complete line is a record `{"line": text}`, invalid UTF-8 dropped and the
/// line ending removed. Every activity walk replays the whole file: the
/// lines up to the mark run the rules again with `Scope::fresh` false, so
/// the state they set is rebuilt instead of stored; a new line still
/// unterminated ends the walk before it. A usage checkpoint names itself
/// `kind`.
#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct TextRecords<V: Vendor> {
    pub kind: Str,
    pub usage: Option<FileUsage<V>>,
}

/// Token usage read from a file's tail.
#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct FileUsage<V: Vendor> {
    /// Slots that start a usage read with another value than the file's.
    pub slots: &'static [Seed<V>],
    pub rules: &'static [UsageRule<V>],
    pub mode: FileMode,
    /// Slots persisted in the checkpoint (and restored from it).
    pub persist: &'static [V::Slot],
    /// The `persist` slots stored as JSON booleans (set = `true`).
    pub flags: &'static [V::Slot],
    /// When a checkpoint's persisted slots and totals are thrown away.
    pub restore: Restore,
}

impl<V: Vendor> FileUsage<V> {
    /// One event per record, `window` dedup keys remembered across reads.
    pub const fn per_record(rules: &'static [UsageRule<V>], window: usize) -> Self {
        FileUsage {
            slots: &[],
            rules,
            mode: FileMode::PerRecord { window, keep_on_rotation: false, credited: false },
            persist: &[],
            flags: &[],
            restore: Restore::UnlessRotated,
        }
    }
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
pub enum Restore {
    /// Whenever the cursor restarts (rewrite, shrink, replacement).
    UnlessRotated,
    /// Only when the file is a different one (identity changed).
    UnlessReplaced,
}

#[derive(Debug, Serialize, Clone, Copy)]
pub enum FileMode {
    /// One event per record. `window`: dedup keys remembered across reads
    /// (`recent_keys`; 0 = none kept); `keep_on_rotation`: the window survives
    /// a rewrite; `credited`: a full re-read after a rewrite replays the
    /// already-credited count silently (`credited_count`).
    PerRecord { window: usize, keep_on_rotation: bool, credited: bool },
    /// The record carries running totals: one event per read with the delta.
    /// `stamp`: constants every checkpoint carries; a checkpoint with totals
    /// but without them re-derives its baseline from the last totals record
    /// before its offset.
    Cumulative { stamp: &'static [(Str, i64)] },
    /// The running totals live in one JSON document beside the transcript
    /// (`<stem><suffix>`, rewritten in place), not in its records: the rules
    /// read that document, and each read yields the delta since the totals
    /// last credited. The checkpoint is main's legacy seen-set
    /// (`{"kind": "legacy", "legacy_seen": [...]}`): the credited keys plus one
    /// `mark + "<in>:<out>"` key. A shrink re-baselines without an event.
    Snapshot { suffix: Str, mark: Str },
}

/// `Sqlite`: one database for every session. Records are the rows of the
/// declared queries, read into JSON objects by column name.
#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct SqliteRecords<V: Vendor> {
    /// Columns that hold JSON text: read as the parsed value (`null` when malformed).
    pub json: &'static [Str],
    /// Columns that hold binary blobs: kept as bytes (`Scope::blob`), and
    /// `null` in the record.
    pub binary: &'static [Str],
    /// Columns each table must have (`PRAGMA table_info`), checked once per
    /// read: a store without them is `Error::Unsupported`.
    pub requires: &'static [(Str, &'static [Str])],
    /// What a database that cannot be read this cycle (missing, busy,
    /// locked, a query its schema does not fit) answers.
    pub unreadable: Unreadable,
    /// Slots a walk starts with that are read from the store itself, on the
    /// walk's own connection.
    pub seeds: &'static [StoreSeed<V>],
    pub usage: SqlUsage<V>,
    pub activity: SqlWalk<V>,
}

/// A slot's first value, from the database being walked.
#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct StoreSeed<V: Vendor> {
    pub slot: V::Slot,
    /// The first column of every row, bytes decoded as UTF-8 with invalid
    /// sequences dropped (Python `errors="ignore"`), concatenated. When the
    /// query fails, the database file's own bytes the same way (a live store
    /// mid-write).
    pub sql: Str,
    /// The slot's value, evaluated over the record `{"text": <that text>}`.
    pub value: Text<V>,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
pub enum Unreadable {
    /// No rows this cycle, as main's reader treats it without a word.
    Quiet,
    /// `Error::Unsupported`: main's reader says so (a warning) when it cannot
    /// read the store, so it takes the call.
    Unsupported,
}

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub enum SqlUsage<V: Vendor> {
    /// No token usage is stored: nothing read, the checkpoint as it was.
    None,
    /// No token records, read the way main's base reader reads them: no
    /// events, and its legacy seen-set checkpoint kept
    /// (`{"kind": "legacy", "legacy_seen": [...]}`).
    Legacy,
    /// One event per row after the checkpoint's `row_id` (main's `{"kind":
    /// "sqlite", "row_id", "identity"}`); `sql` binds that watermark as `?`.
    After { rules: &'static [UsageRule<V>], sql: Str, id: Str },
    /// One event per row after an anchored `row_id` watermark.
    Anchored(Anchored<V>),
    /// One of several usage declarations, chosen per read by the vendor's
    /// probe of the store (a database whose schema changed between versions
    /// of the CLI). No variant: nothing read, the checkpoint as it was.
    OneOf { probe: V::Ext, of: &'static [SqlUsage<V>] },
    /// Rows that each hold one key's running counters. Every read reads them
    /// all; the checkpoint keeps each key's last counters as `{"kind": kind,
    /// map: {key: [counters…]}}`. The rules see the row with `delta` (column →
    /// growth, floored at 0) and `counters` (`"a:b:…"`) added; a row that did
    /// not grow yields nothing.
    Counters { rules: &'static [UsageRule<V>], sql: Str, id: Str, kind: Str, map: Str, columns: &'static [Str] },
    /// Rows read per partition, one event per row with a reading; the
    /// checkpoint keeps each partition's last read id, held rows excluded, as
    /// `{"kind": kind, map: {part: id}}`.
    Watermarks { rules: &'static [UsageRule<V>], page: Page<V>, part: Partition<V>, kind: Str, map: Str },
}

/// One event per row after the checkpoint's `row_id`, where the id alone does
/// not prove the store is the same one: the checkpoint also keeps the
/// watermark row's `anchor` columns (`str()` of each, joined by `|`). A row
/// standing under the watermark id with another anchor was never credited
/// (the read starts just below it); a store whose newest id fell below the
/// watermark is re-anchored at that id without a rescan. The watermark
/// follows every row read, with or without a reading.
#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct Anchored<V: Vendor> {
    pub rules: &'static [UsageRule<V>],
    /// `?1` is the watermark (`?2`: see `settling`); the rows come oldest
    /// first, with the anchor columns under their own names.
    pub sql: Str,
    pub id: Str,
    /// The newest id (`SELECT COALESCE(MAX(id), 0) FROM …`).
    pub newest: Str,
    /// Binds an id (`?`) and returns that row's anchor columns.
    pub anchor_sql: Str,
    pub anchor: &'static [Str],
    pub settling: Option<Settling<V>>,
    /// A key and value the checkpoint carries. A watermark without it was
    /// taken on another table of the same file (an older schema whose rows
    /// were copied over): the read starts at the newest id, crediting nothing.
    pub tag: Option<(Str, Str)>,
    pub lookup: Option<Lookup>,
}

impl<V: Vendor> Anchored<V> {
    /// Rows written once: nothing settles, no tag, no lookup.
    pub const fn of(rules: &'static [UsageRule<V>], sql: Str, id: Str, newest: Str, anchor_sql: Str, anchor: &'static [Str]) -> Self {
        Anchored { rules, sql, id, newest, anchor_sql, anchor, settling: None, tag: None, lookup: None }
    }
}

/// Rows that are rewritten in place until they are complete. One matching
/// `when` yields nothing and is read again on later passes: `sql` binds the
/// ids still settling as a JSON list (`?2`), and the checkpoint keeps the
/// newest `cap` of them as `pending`.
#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct Settling<V: Vendor> {
    pub when: Pred<V>,
    pub cap: usize,
}

/// A value each row gets from another query, which the store may not be
/// able to answer (a column older versions lack): `sql` returns `key` and
/// `value` columns, and a row whose `by` column equals a key gets the value
/// as its `column` ("" when there is none, or the query fails).
#[derive(Debug, Serialize)]
pub struct Lookup {
    pub sql: Str,
    pub by: Str,
    pub column: Str,
}

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub enum SqlWalk<V: Vendor> {
    /// One of several walks, chosen per pass by the vendor's probe of the
    /// store. Each keeps its own mark (declare them as `Tables`, whose marks
    /// are kept by key). No variant: nothing walked.
    OneOf { probe: V::Ext, of: &'static [SqlWalk<V>] },
    /// Rows after one database-wide id, kept in the bag as `key + id`.
    Rows(RowWalk<V>),
    /// Several row walks in one pass, each with its own watermark and bag
    /// key, in order (a store whose activity is spread over more than one
    /// table). The rules tell their rows apart by a column the queries add.
    Tables(&'static [RowWalk<V>]),
    /// Rows after each partition's id, kept as `key + part + "::" + id`.
    /// `anchor` is the bag key that records the database's first sight: every
    /// partition then present starts at its newest id, and one that appears
    /// later is read from its start. `restart_below`: a partition whose
    /// newest id fell below its mark starts over at it.
    Partitions { page: Page<V>, part: Partition<V>, restart_below: bool, key: Str, anchor: Str },
}

#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct RowWalk<V: Vendor> {
    /// `?1` is the watermark, `?2` the page size (`?3`: see `revisit`).
    pub sql: Str,
    /// The column holding the increasing row id the watermark follows.
    pub id: Str,
    /// The newest id (`SELECT COALESCE(MAX(id), 0) FROM …`).
    pub newest: Str,
    /// Rows per pass (`-1`: no limit).
    pub page: i64,
    pub first_sight: FirstSight,
    pub shrink: Shrink,
    /// A last row matching this is not consumed yet (it is read again next
    /// pass, when it may have changed).
    pub hold_last: Option<Pred<V>>,
    /// Rows that are read again on later passes until they settle.
    pub revisit: Option<Revisit<V>>,
    /// Each row gets this boolean column: it is the newest row of the pass.
    pub last_as: Option<Str>,
    pub key: Str,
}

/// Where a row walk starts in a database it has never walked.
#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
pub enum FirstSight {
    /// At the newest id: everything already in the database is history.
    Newest,
    /// At the first row: the watcher has not seen any of it.
    Start,
}

/// What a newest id below the watermark (a replaced database) does.
#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
pub enum Shrink {
    /// Nothing: the newest id is not looked at.
    Ignore,
    /// The walk starts over at the newest id (nothing is replayed).
    ToNewest,
    /// The walk starts over at the first row and reads on in the same pass:
    /// under restarted ids nothing in the store has been delivered yet.
    ToStart,
}

/// Rows matching `when` (a step still streaming) stay pending: the walk's
/// query binds their ids as a JSON list (`?3`), a pending row read again
/// yields nothing until it no longer matches, and the ids are kept in the bag
/// as `key + json(sorted ids)`.
#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct Revisit<V: Vendor> {
    pub when: Pred<V>,
    pub key: Str,
}

/// One page of a partition's rows: `sql` binds the partition (`?1`), its
/// watermark (`?2`) and the page size (`?3`).
#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct Page<V: Vendor> {
    pub sql: Str,
    pub id: Str,
    pub size: i64,
    pub hold_last: Option<Pred<V>>,
}

/// The partitions of one table (a session each), and the label a
/// partition's rows carry.
#[derive(Debug, Serialize)]
#[serde(bound = "")]
pub struct Partition<V: Vendor> {
    /// Every partition with its newest id, as columns `part` and `top`. A
    /// partition whose newest id is not above its watermark is not queried.
    pub tops: Str,
    /// The label (column `label_as` on each row): the first non-empty text,
    /// evaluated over the first row of its query with the partition bound as
    /// `?1`. A query that fails (its table is absent in this build) is
    /// skipped. A resolved label is remembered; a partition with none is
    /// labelled with its own name, looked up again next read, and reported
    /// once through `unlabelled` (`{path}` and `{part}` filled in).
    pub label: &'static [(Str, Text<V>)],
    pub label_as: Str,
    pub unlabelled: Str,
}

/// One CLI's whole declaration as JSON (`navide-cli-runtime declarations`).
pub fn export<V: Vendor>() -> serde_json::Value {
    let mut out = serde_json::to_value(V::CLI).unwrap_or_default();
    if let Some(object) = out.as_object_mut() {
        object.insert("observe".into(), serde_json::to_value(V::OBSERVE).unwrap_or_default());
    }
    out
}
