//! Grok Build. Transcripts: `~/.grok/sessions/<url-encoded cwd>/<session>/updates.jsonl`,
//! ACP `session/update` records; `turn_completed` ends a turn and carries its usage.
use crate::decl::*;
use crate::expr::{py_float, py_strip, Scope};
use crate::observe::{dir_name, nth_dir};
use crate::text::unquote;
use crate::time;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug)]
pub struct V;

slots! { Cwd = "cwd", SessionId = "session_id", Pending = "pending" }

/// What only Grok's update log needs.
#[derive(Debug, Clone, Copy, Serialize)]
pub enum Ext {
    /// Slot: the cwd is the session group directory's name, URL-decoded; a
    /// shortened name cannot be decoded, and its `.cwd` file holds the path.
    GroupDir,
    /// Text: millisecond `_meta.agentTimestampMs`, else the seconds
    /// `timestamp`, as ISO-8601 with truncated milliseconds.
    Stamp,
    /// Text: the model, which is the first key of the usage's `modelUsage` map.
    Model,
    /// Text: the key of the `modelUsage` entry a turn call is read from.
    EntryModel,
}

impl Vendor for V {
    type Slot = Slot;
    type Ext = Ext;
    type Backend = Jsonl;
    const CLI: &'static Cli = &CLI;
    const OBSERVE: Option<&'static Observe<Self>> = Some(&OBSERVE);

    fn text(ext: Ext, scope: &Scope<'_, Self>) -> String {
        match ext {
            Ext::Stamp => {
                let seconds = match scope.get(&["params", "_meta", "agentTimestampMs"]).filter(|v| !v.is_null()) {
                    Some(ms) => py_float(Some(ms)).unwrap_or(0.0) / 1000.0,
                    None => py_float(scope.get(&["timestamp"])).unwrap_or(0.0),
                };
                if seconds == 0.0 { String::new() } else { time::iso_truncated_ms(seconds) }
            }
            Ext::Model => scope
                .get(&["params", "update", "usage", "modelUsage"])
                .and_then(Value::as_object)
                .and_then(|models| models.keys().next().cloned())
                .unwrap_or_default(),
            Ext::EntryModel => scope.entry_key.to_owned(),
            Ext::GroupDir => String::new(),
        }
    }

    fn init(ext: Ext, path: &std::path::Path) -> String {
        match ext {
            Ext::GroupDir => {
                let marker = nth_dir(path, 2).map(|dir| dir.join(".cwd"));
                match marker.filter(|m| m.is_file()).and_then(|m| std::fs::read_to_string(m).ok()) {
                    Some(text) => py_strip(&text).to_owned(),
                    None => unquote(&dir_name(path, 2)),
                }
            }
            _ => String::new(),
        }
    }
}

const KIND: Path = &["params", "update", "sessionUpdate"];
const SESSION: Text<V> = Text::Py(&["params", "sessionId"]);
/// The CLI's own per-session event counter, else the byte offset.
const IDENT: Text<V> = Text::FirstOf(&[Text::Py(&["params", "_meta", "eventId"]), Text::Concat(&[SESSION, Text::Lit("@"), Text::Offset])]);
const ISO: Text<V> = Text::Ext(Ext::Stamp);
/// A chunk's visible text: one text block, or a list of them.
const CHUNK: Text<V> = Text::Concat(&[
    Text::If(
        &Pred::All(&[Pred::IsObject(&["params", "update", "content"]), Pred::Eq(&["params", "update", "content", "type"], "text")]),
        &Text::Py(&["params", "update", "content", "text"]),
    ),
    Text::Join { list: &["params", "update", "content"], filter: &Pred::Eq(&["type"], "text"), item: &Text::Py(&["text"]), sep: "", keep_empty: true },
]);
const TURN_USAGE: Pred<V> = Pred::All(&[Pred::Eq(KIND, "turn_completed"), Pred::IsObject(&["params", "update", "usage"])]);
const ACT_KEY: Text<V> = Text::Concat(&[Text::Lit("act:"), IDENT]);

pub static CLI: Cli = Cli {
    key: "grok",
    label: "Grok Build (SpaceXAI)",
    kind: Kind::Cli,
    order: Order { menu: 40, registry: 100 },
    // `--always-approve` exists but is deliberately not wired (see agents/grok.ts).
    launch: Launch {
        model: Some(&["--model", "{}"]),
        // The two child markers are the community grok-cli's, stamped on its
        // own subprocesses. Kept for the official CLI: a string scan of its
        // binary finds neither, but that scan also misses GROK_SANDBOX, which
        // `grok --help` states outright. Stripping a marker that does exist
        // matters; carrying one that does not costs nothing.
        env_strip: &["GROK_HOME", "GROK_BACKGROUND_CHILD", "GROK_DAEMON_CHILD"],
        ..Launch::of("grok")
    },
    resume: Resume {
        args: Some(&["-r", "{id}"]),
        parse: Some(ResumeParse {
            programs: &["grok"],
            tokens: Tokens::Literal,
            subcommand: &[],
            id_after_subcommand: false,
            flags: &["-r", "--resume"],
            joined: Some(ValueShape::Uuid),
            pick: Pick::First,
            // grok also accepts titles; only a UUID names the transcript.
            value: ValueShape::Uuid,
        }),
    },
    interrupt: b"\x03",
};

static OBSERVE: Observe<V> = Observe {
    file_name: Some("updates.jsonl"),
    other_files: OtherFiles::Empty,
    slots: &[Seed { slot: Slot::Cwd, init: SlotInit::Ext(Ext::GroupDir) }, Seed { slot: Slot::SessionId, init: SlotInit::DirName(1) }],
    cwd: Some(Slot::Cwd),
    session: Some(Slot::SessionId),
    cwd_form: Form::Written,
    records: JsonlRecords {
        usage: Some(FileUsage::per_record(
            &[UsageRule {
                when: TURN_USAGE,
                effects: &[],
                reading: Some(Reading {
                    model: Text::Ext(Ext::Model),
                    timestamp: ISO,
                    cwd: Text::Slot(Slot::Cwd),
                    session_id: SESSION,
                    // inputTokens is the whole input (cache folded in), outputTokens includes reasoning.
                    ..Reading::of(
                        Num::Of(&["params", "update", "usage", "inputTokens"]),
                        Num::Of(&["params", "update", "usage", "outputTokens"]),
                        Text::Concat(&[Text::Lit("usage:"), IDENT]),
                    )
                }),
            }],
            0,
        )),
        // eventId is not in file order (hook records take theirs when queued), so the
        // cursor is a byte offset.
        cursor: LineCursor::Bytes { key: "grok_act::" },
    },
    activity: Activity {
        kept: &[Kept { slot: Slot::Pending, prefix: "grok_text::", form: KeptForm::JsonText }],
        ..Activity::rules(&[
            Rule { when: Pred::Eq(KIND, "agent_message_chunk"), effects: &[Effect::Append(Slot::Pending, CHUNK, 4000)] },
            Rule {
                when: Pred::Eq(KIND, "turn_completed"),
                effects: &[
                    Emit::done(
                        Text::Concat(&[Text::Lit("turn:"), IDENT]),
                        Text::FirstOf(&[Text::Py(&["params", "update", "stop_reason"]), Text::Lit("end_turn")]),
                        Text::Slot(Slot::Pending),
                        ISO,
                    )
                    .of_session(SESSION)
                    .effect(),
                    Effect::Set(Slot::Pending, Text::Lit("")),
                    Effect::Stop,
                ],
            },
            Rule {
                when: Pred::Eq(KIND, "user_message_chunk"),
                effects: &[Emit::active(ACT_KEY, Text::Lit("user"), Text::UserPrompt(&CHUNK), ISO).of_session(SESSION).effect()],
            },
            Rule {
                when: Pred::Eq(KIND, "agent_message_chunk"),
                effects: &[Emit::active(ACT_KEY, Text::Lit("assistant"), Text::Lit(""), ISO).of_session(SESSION).effect()],
            },
        ])
    },
    turns: Turns::Exact(&ExactTurns {
        slots: &[],
        filter: SessionFilter::Record(SESSION),
        effects: &[],
        skip: None,
        open: Some(TurnOpen { when: Pred::Eq(KIND, "user_message_chunk"), mode: OpenMode::Join, prompt: CHUNK, merge: PromptMerge::Merge, started: ISO }),
        // One turn per turn_completed; its modelUsage entries are the calls.
        call: TurnCall {
            when: TURN_USAGE,
            each: Some(Each { map: &["params", "update", "usage", "modelUsage"], fallback: &["params", "update", "usage"] }),
            input: Num::Of(&["inputTokens"]),
            cache_read: Num::Of(&["cachedReadTokens"]),
            cache_creation: Num::Of(&["cacheCreationTokens"]),
            output: Num::Of(&["outputTokens"]),
            input_includes_cache: true,
            cumulative: false,
            skip_zero: false,
            key: None,
            key_invalid: "",
            model: Text::Ext(Ext::EntryModel),
            ts: ISO,
            cli_version: Text::Lit(""),
            orphan: Orphan::ToClose,
        },
        close: Some(TurnClose {
            when: TURN_USAGE,
            ended: ISO,
            session: Some(SESSION),
            model_calls: Some(Num::Of(&["params", "update", "usage", "modelCalls"])),
            drop_empty: true,
        }),
        // main reads the transcript through its lenient record reader.
        strict_utf8: false,
    }),
};
