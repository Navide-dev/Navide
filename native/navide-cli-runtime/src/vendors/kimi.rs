//! Kimi Code CLI. Sessions: `~/.kimi-code/sessions/session_<uuid>/agents/main/wire.jsonl`,
//! the cwd in the session's `state.json`. A turn ends at `turn.ended` (0.39+),
//! `turn.cancel`, the next prompt, or 8 s past its last epoch-ms stamp.
use crate::decl::*;
use crate::expr::{py_int_raw, Scope};
use serde::Serialize;

#[derive(Debug)]
pub struct V;

slots! { Cwd = "cwd", SessionId = "session_id", Reply = "reply" }

/// What only Kimi's wire log needs.
#[derive(Debug, Clone, Copy, Serialize)]
pub enum Ext {
    /// Text: the record's epoch-millisecond `time` as digits ("" when it is
    /// not a number), which is the timestamp its events carry.
    Millis,
    /// Test: the open turn was cancelled (loop events still trickle in).
    Cancelled,
}

impl Vendor for V {
    type Slot = Slot;
    type Ext = Ext;
    type Backend = Jsonl;
    const CLI: &'static Cli = &CLI;
    const OBSERVE: Option<&'static Observe<Self>> = Some(&OBSERVE);

    fn text(ext: Ext, scope: &Scope<'_, Self>) -> String {
        match ext {
            Ext::Millis => scope.get(&["time"]).and_then(py_int_raw).map(|ms| ms.to_string()).unwrap_or_default(),
            Ext::Cancelled => String::new(),
        }
    }

    fn pred(ext: Ext, scope: &Scope<'_, Self>) -> bool {
        matches!(ext, Ext::Cancelled) && scope.cancelled
    }
}

const MS: Num<V> = Num::Of(&["time"]);
const STAMP: Text<V> = Text::Ext(Ext::Millis);
const LINE_KEY: Text<V> = Text::Concat(&[Text::Lit("act:"), Text::Line]);
const PART_TEXT: Text<V> = Text::Strip(&Text::Py(&["event", "part", "text"]));

pub static CLI: Cli = Cli {
    key: "kimi",
    label: "Kimi Code CLI (Moonshot AI)",
    kind: Kind::Cli,
    order: Order { menu: 50, registry: 130 },
    // Effort lives in config.toml, not on the command line.
    launch: Launch {
        yolo_args: &["--yolo"],
        model: Some(&["--model", "{}"]),
        // pi-tui otherwise treats a split ESC prefix as Escape after 10 ms; pane
        // input crosses the renderer, a WebSocket and the PTY, so Kimi gets the
        // reassembly window pi-tui already uses for remote terminals.
        env_defaults: &[("PI_TUI_ESC_TIMEOUT", "100")],
        env_strip: &["KIMI_CODE_HOME"],
        ..Launch::of("kimi")
    },
    resume: Resume {
        args: Some(&["--session", "{id}"]),
        parse: Some(ResumeParse {
            programs: &["kimi"],
            tokens: Tokens::Whitespace,
            subcommand: &[],
            id_after_subcommand: false,
            flags: &["--session", "-S"],
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
        Seed { slot: Slot::Cwd, init: SlotInit::SidecarJson { up: 3, file: "state.json", keys: &["cwd", "workDir"] } },
        Seed { slot: Slot::SessionId, init: SlotInit::DirName(3) },
    ],
    cwd: Some(Slot::Cwd),
    session: Some(Slot::SessionId),
    cwd_form: Form::Written,
    records: JsonlRecords {
        usage: Some(FileUsage {
            persist: &[Slot::Cwd],
            ..FileUsage::per_record(
                &[UsageRule {
                    when: Pred::All(&[Pred::Eq(&["type"], "usage.record"), Pred::IsObject(&["usage"])]),
                    effects: &[],
                    reading: Some(Reading {
                        model: Text::Py(&["model"]),
                        timestamp: STAMP,
                        cwd: Text::Slot(Slot::Cwd),
                        session_id: Text::Slot(Slot::SessionId),
                        ..Reading::of(
                            Num::Sum(&[Num::Of(&["usage", "inputOther"]), Num::Of(&["usage", "inputCacheRead"]), Num::Of(&["usage", "inputCacheCreation"])]),
                            Num::Of(&["usage", "output"]),
                            // usage.record is written whole, so its byte offset is a stable key.
                            Text::Concat(&[Text::Lit("kimi::"), Text::Slot(Slot::SessionId), Text::Lit("::@"), Text::Offset]),
                        )
                    }),
                }],
                0,
            )
        }),
        cursor: LineCursor::Lines,
    },
    activity: Activity {
        idle: Some(Idle { after_ms: 8000, clock: Clock::TurnMillis, detail: "idle" }),
        turn_stamp: TurnStamp::Millis,
        turn_text: Some(Slot::Reply),
        kept: &[Kept { slot: Slot::Reply, prefix: "kimi_text::", form: KeptForm::Text }],
        turn_key: Some(TurnKey { prefix: "kimi_turn::", compact: true, keep_null: true }),
        ..Activity::rules(&[
            Rule {
                when: Pred::Eq(&["type"], "turn.prompt"),
                effects: &[
                    Effect::Turn(TurnOp::Open { boundary: "boundary", ts: Text::Lit(""), ms: MS }),
                    Emit::active(LINE_KEY, Text::Lit("prompt"), Text::UserPrompt(&Text::Blocks(&["input"], "text")), STAMP).effect(),
                ],
            },
            Rule {
                when: Pred::Eq(&["type"], "usage.record"),
                effects: &[Effect::Turn(TurnOp::Touch { ts: None, ms: Some(MS) }), Emit::active(LINE_KEY, Text::Lit("usage"), Text::Lit(""), STAMP).effect()],
            },
            // A cancelled turn ignores the loop events still trickling in.
            Rule { when: Pred::All(&[Pred::Eq(&["type"], "context.append_loop_event"), Pred::Ext(Ext::Cancelled)]), effects: &[Effect::Stop] },
            Rule {
                when: Pred::Eq(&["type"], "context.append_loop_event"),
                effects: &[
                    Effect::Turn(TurnOp::Touch { ts: None, ms: Some(MS) }),
                    Effect::When(
                        &Pred::All(&[
                            Pred::Eq(&["event", "type"], "content.part"),
                            Pred::In(&["event", "part", "type"], &["text", "think"]),
                            Pred::Text(PART_TEXT, StrTest::NonEmpty),
                        ]),
                        &[
                            // New content disproves an inferred idle end; late accounting does not.
                            Effect::Turn(TurnOp::EnsureOpen { ts: Text::Lit(""), ms: MS }),
                            Effect::When(&Pred::Eq(&["event", "part", "type"], "text"), &[Effect::Set(Slot::Reply, Text::Cap(&PART_TEXT, 4000))]),
                        ],
                    ),
                ],
            },
            Rule { when: Pred::Eq(&["type"], "turn.ended"), effects: &[Effect::Turn(TurnOp::Close { detail: "turn-ended", ms: Some(MS) })] },
            Rule { when: Pred::Eq(&["type"], "turn.cancel"), effects: &[Effect::Turn(TurnOp::Cancel { detail: "cancel", ms: Some(MS) })] },
        ])
    },
    turns: Turns::Inferred,
};
