//! Muse Code (Meta). Sessions: `$XDG_DATA_HOME|~/.local/share/muse/sessions/
//! <Y>/<M>/<D>/<id>/session.jsonl` (a subagent's log, under
//! `<id>/subagent/<child>/`, is not one). Records are envelopes: a
//! `runtime.session` envelope carries a run event in `payload.event`.
use crate::decl::*;
use crate::expr::{py_int_raw, Scope};
use crate::observe::dir_name;
use crate::time;
use serde::Serialize;

#[derive(Debug)]
pub struct V;

slots! { Cwd = "cwd", CliVersion = "cli_version", SessionId = "session_id", Reply = "reply" }

/// What only Muse's logs need.
#[derive(Debug, Clone, Copy, Serialize)]
pub enum Ext {
    /// Text: the envelope's `recorded_at` (epoch microseconds) as ISO-8601.
    RecordedAt,
    /// Slot: every log is `session.jsonl`, so the id is its directory's
    /// name; a subagent's log has none (`muse resume` would reject it).
    SessionId,
}

/// A main session's log: a subagent's sits at `<session>/subagent/<child>/`,
/// so its grandparent is literally named `subagent`.
fn main_session(path: &std::path::Path) -> bool {
    dir_name(path, 2) != "subagent"
}

impl Vendor for V {
    type Slot = Slot;
    type Ext = Ext;
    type Backend = Jsonl;
    const CLI: &'static Cli = &CLI;
    const OBSERVE: Option<&'static Observe<Self>> = Some(&OBSERVE);

    fn text(ext: Ext, scope: &Scope<'_, Self>) -> String {
        match ext {
            Ext::RecordedAt => scope.get(&["recorded_at"]).and_then(py_int_raw).map(time::iso_from_micros).unwrap_or_default(),
            Ext::SessionId => String::new(),
        }
    }

    fn init(ext: Ext, path: &std::path::Path) -> String {
        match ext {
            Ext::SessionId if main_session(path) => dir_name(path, 1),
            _ => String::new(),
        }
    }

    /// A subagent's usage is attributed into the parent's log too: reading
    /// its own log would count it twice.
    fn accepts(path: &std::path::Path) -> bool {
        main_session(path)
    }
}

const TS: Text<V> = Text::Ext(Ext::RecordedAt);
const LINE_KEY: Text<V> = Text::Concat(&[Text::Lit("act:"), Text::Line]);
const RUN_EVENT: Pred<V> = Pred::All(&[Pred::Eq(&["payload_type"], "runtime.session"), Pred::IsObject(&["payload", "event"])]);
const KIND: Path = &["payload", "event", "kind"];
const RECORD: Path = &["payload", "event", "record"];
const METADATA: Pred<V> = Pred::Eq(&["payload_type"], "runtime.session.metadata");
const HAS_RECORD: Pred<V> = Pred::IsObject(&["payload", "record"]);
const CWD: Text<V> = Text::If(&HAS_RECORD, &Text::Py(&["payload", "record", "workspace_root"]));
const VERSION: Text<V> = Text::If(
    &HAS_RECORD,
    &Text::If(&Pred::IsObject(&["payload", "record", "build"]), &Text::Py(&["payload", "record", "build", "semver"])),
);
/// The first metadata record within 20 lines names it ("" when its record is not an object).
const fn metadata(field: Text<V>) -> SlotInit<V> {
    SlotInit::Header { lines: 20, when: METADATA, field, first_line: false }
}

pub static CLI: Cli = Cli {
    key: "muse",
    label: "Muse Code (Meta)",
    kind: Kind::Cli,
    order: Order { menu: 130, registry: 160 },
    launch: Launch {
        yolo_args: &["--disable-approval"],
        model: Some(&["--model", "{}"]),
        effort: Some(&["--reasoning-effort", "{}"]),
        efforts: &["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
        ..Launch::of("muse")
    },
    resume: Resume {
        args: Some(&["resume", "{id}"]),
        parse: Some(ResumeParse {
            programs: &["muse"],
            tokens: Tokens::Whitespace,
            subcommand: &["resume"],
            id_after_subcommand: true,
            flags: &[],
            joined: None,
            pick: Pick::First,
            value: ValueShape::Any,
        }),
    },
    interrupt: b"\x03",
};

static OBSERVE: Observe<V> = Observe {
    file_name: Some("session.jsonl"),
    other_files: OtherFiles::Empty,
    slots: &[
        Seed { slot: Slot::Cwd, init: metadata(CWD) },
        Seed { slot: Slot::CliVersion, init: metadata(VERSION) },
        Seed { slot: Slot::SessionId, init: SlotInit::Ext(Ext::SessionId) },
    ],
    cwd: Some(Slot::Cwd),
    session: Some(Slot::SessionId),
    cwd_form: Form::Written,
    records: JsonlRecords {
        usage: Some(FileUsage::per_record(
            &[UsageRule {
                // A main-requester goal_usage_attribution (cached and reasoning
                // tokens are inside input and output, so not added).
                when: Pred::All(&[
                    RUN_EVENT,
                    Pred::Eq(KIND, "goal_usage_attribution"),
                    Pred::IsObject(RECORD),
                    Pred::IsObject(&["payload", "event", "record", "owner"]),
                    Pred::Eq(&["payload", "event", "record", "owner", "requester_kind"], "main"),
                    Pred::IsObject(&["payload", "event", "record", "quantity"]),
                ]),
                effects: &[],
                reading: Some(Reading {
                    key_required: true,
                    timestamp: TS,
                    cli_version: Text::Slot(Slot::CliVersion),
                    cwd: Text::Slot(Slot::Cwd),
                    session_id: Text::Slot(Slot::SessionId),
                    ..Reading::of(
                        Num::Of(&["payload", "event", "record", "quantity", "input_tokens"]),
                        Num::Of(&["payload", "event", "record", "quantity", "output_tokens"]),
                        Text::Py(&["payload", "event", "record", "usage_id"]),
                    )
                }),
            }],
            64,
        )),
        cursor: LineCursor::Lines,
    },
    activity: Activity {
        kept: &[Kept { slot: Slot::Reply, prefix: "muse_text::", form: KeptForm::Text }],
        ..Activity::rules(&[
            // A submitted turn (slash commands, cancels and other intake kinds are not).
            Rule {
                when: Pred::All(&[
                    Pred::Eq(&["payload_type"], "runtime.command_intake.received"),
                    Pred::IsObject(&["payload", "record"]),
                    Pred::IsObject(&["payload", "record", "command"]),
                    Pred::Eq(&["payload", "record", "command", "kind"], "turn_submit"),
                ]),
                effects: &Emit::active(LINE_KEY, Text::Lit("user"), Text::UserPrompt(&Text::Py(&["payload", "record", "command", "prompt"])), TS).last(),
            },
            Rule {
                when: Pred::All(&[RUN_EVENT, Pred::Eq(KIND, "assistant_message_committed")]),
                effects: &[Effect::SetIfNonEmpty(Slot::Reply, Text::Cap(&Text::Strip(&Text::Py(&["payload", "event", "text"])), 4000))],
            },
            // Work events only: muse logs its task graph in the same stream.
            Rule {
                when: Pred::All(&[
                    RUN_EVENT,
                    Pred::In(KIND, &["started", "assistant_message_committed", "side_effect_intent", "model_completed", "completed", "failed"]),
                ]),
                effects: &[Emit::active(LINE_KEY, Text::Py(KIND), Text::Lit(""), TS).effect()],
            },
            // Any terminal value ends the turn; the value rides on detail.
            Rule {
                when: Pred::All(&[RUN_EVENT, Pred::Eq(KIND, "terminal")]),
                effects: &[
                    Emit::done(Text::Concat(&[Text::Lit("turn:"), Text::Line]), Text::Py(&["payload", "event", "terminal"]), Text::Slot(Slot::Reply), TS).effect(),
                    Effect::Set(Slot::Reply, Text::Lit("")),
                ],
            },
        ])
    },
    turns: Turns::Inferred,
};
