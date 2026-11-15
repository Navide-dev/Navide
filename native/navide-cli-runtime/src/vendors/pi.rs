//! Pi. Sessions: `~/.pi/agent/sessions/--<encoded cwd>--/<ts>_<id>.jsonl`,
//! line 1 a `session` header. Files are rewritten in place (migrations,
//! /tree), so usage keeps its dedup window and a credited count across
//! rewrites. No end-of-turn record: turns are inferred like qwen's.
use crate::decl::*;
use serde::Serialize;

#[derive(Debug)]
pub struct V;

slots! { SessionId = "session_id", Cwd = "cwd", Reply = "reply" }

/// What only Pi's sessions need.
#[derive(Debug, Clone, Copy, Serialize)]
pub enum Ext {
    /// Slot: the id is the file stem after its first `_` (`<ts>_<id>`), for
    /// a file whose header names none.
    StemId,
}

impl Vendor for V {
    type Slot = Slot;
    type Ext = Ext;
    type Backend = Jsonl;
    const CLI: &'static Cli = &CLI;
    const OBSERVE: Option<&'static Observe<Self>> = Some(&OBSERVE);

    fn init(ext: Ext, path: &std::path::Path) -> String {
        match ext {
            Ext::StemId => {
                let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
                stem.split_once('_').map(|(_, rest)| rest.to_owned()).unwrap_or_default()
            }
        }
    }
}

const TS: Text<V> = Text::Py(&["timestamp"]);
const LINE_KEY: Text<V> = Text::Concat(&[Text::Lit("act:"), Text::Line]);
const CONTENT: Path = &["message", "content"];
const NOT_HEADER: Pred<V> = Pred::Not(&Pred::Eq(&["type"], "session"));

const fn header(field: Text<V>) -> SlotInit<V> {
    SlotInit::Header { lines: 0, when: Pred::Eq(&["type"], "session"), field, first_line: true }
}

/// One usage record, read at `input` / `output` / the two cache paths.
const fn reading(input: Num<V>, output: Num<V>) -> Reading<V> {
    Reading {
        key_required: true,
        model: Text::FirstOf(&[Text::Py(&["message", "model"]), Text::Py(&["model"])]),
        timestamp: TS,
        cwd: Text::Slot(Slot::Cwd),
        session_id: Text::Slot(Slot::SessionId),
        ..Reading::of(input, output, Text::Py(&["id"]))
    }
}

pub static CLI: Cli = Cli {
    key: "pi",
    label: "Pi",
    kind: Kind::Cli,
    order: Order { menu: 90, registry: 190 },
    launch: Launch {
        // pi has no permission system to bypass.
        model: Some(&["--model", "{}"]),
        effort: Some(&["--thinking", "{}"]),
        efforts: &["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        env_strip: &["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_PACKAGE_DIR"],
        ..Launch::of("pi")
    },
    resume: Resume {
        args: Some(&["--session-id", "{id}"]),
        parse: Some(ResumeParse {
            programs: &["pi"],
            tokens: Tokens::Whitespace,
            subcommand: &[],
            id_after_subcommand: false,
            flags: &["--session-id"],
            joined: None,
            pick: Pick::Last,
            value: ValueShape::NoDash,
        }),
    },
    interrupt: b"\x03",
};

static OBSERVE: Observe<V> = Observe {
    file_name: None,
    other_files: OtherFiles::Empty,
    slots: &[
        Seed { slot: Slot::SessionId, init: SlotInit::FirstOf(&[header(Text::Py(&["id"])), SlotInit::Ext(Ext::StemId)]) },
        Seed { slot: Slot::Cwd, init: header(Text::Py(&["cwd"])) },
    ],
    cwd: Some(Slot::Cwd),
    session: Some(Slot::SessionId),
    cwd_form: Form::Written,
    records: JsonlRecords {
        usage: Some(FileUsage {
            // main's `_usage_of`: on the message object for assistant
            // messages, at the top level for compaction / branch-summary entries.
            rules: &[
                UsageRule {
                    when: Pred::All(&[NOT_HEADER, Pred::IsObject(&["message"]), Pred::IsObject(&["message", "usage"])]),
                    effects: &[],
                    reading: Some(reading(
                        Num::Sum(&[Num::Of(&["message", "usage", "input"]), Num::Of(&["message", "usage", "cacheRead"]), Num::Of(&["message", "usage", "cacheWrite"])]),
                        Num::Of(&["message", "usage", "output"]),
                    )),
                },
                UsageRule {
                    when: Pred::All(&[NOT_HEADER, Pred::Not(&Pred::IsObject(&["message"])), Pred::IsObject(&["usage"])]),
                    effects: &[],
                    reading: Some(reading(
                        Num::Sum(&[Num::Of(&["usage", "input"]), Num::Of(&["usage", "cacheRead"]), Num::Of(&["usage", "cacheWrite"])]),
                        Num::Of(&["usage", "output"]),
                    )),
                },
            ],
            mode: FileMode::PerRecord { window: 256, keep_on_rotation: true, credited: true },
            persist: &[Slot::SessionId, Slot::Cwd],
            ..FileUsage::per_record(&[], 0)
        }),
        cursor: LineCursor::Lines,
    },
    activity: Activity {
        idle: Some(Idle { after_ms: 8000, clock: Clock::FileMtime, detail: "idle" }),
        turn_text: Some(Slot::Reply),
        kept: &[Kept { slot: Slot::Reply, prefix: "pi_text::", form: KeptForm::Text }],
        turn_key: Some(TurnKey { prefix: "pi_turn::", compact: false, keep_null: false }),
        ..Activity::rules(&[
            Rule {
                when: Pred::All(&[Pred::Eq(&["type"], "message"), Pred::Eq(&["message", "role"], "user")]),
                effects: &[
                    Effect::Turn(TurnOp::Open { boundary: "boundary", ts: TS, ms: Num::Zero }),
                    Emit::active(LINE_KEY, Text::Lit("user"), Text::UserPrompt(&Text::Blocks(CONTENT, "text")), TS).effect(),
                ],
            },
            Rule {
                when: Pred::All(&[Pred::Eq(&["type"], "message"), Pred::Eq(&["message", "role"], "assistant")]),
                effects: &[
                    Effect::Turn(TurnOp::EnsureOpen { ts: TS, ms: Num::Zero }),
                    Effect::Turn(TurnOp::Touch { ts: Some(TS), ms: None }),
                    Effect::SetIfNonEmpty(Slot::Reply, Text::Cap(&Text::Strip(&Text::Blocks(CONTENT, "text")), 4000)),
                    Emit::active(LINE_KEY, Text::Lit("assistant"), Text::Lit(""), TS).effect(),
                ],
            },
        ])
    },
    turns: Turns::Inferred,
};
