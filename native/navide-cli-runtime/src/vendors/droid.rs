//! Droid CLI (Factory). Sessions: `$FACTORY_HOME_OVERRIDE|~/.factory/sessions/
//! [<encoded cwd>/]<id>.jsonl`; token totals live in the `<id>.settings.json`
//! sidecar, not in the transcript.
use crate::decl::*;

#[derive(Debug)]
pub struct V;

slots! { Cwd = "cwd", SessionId = "session_id", Reply = "reply" }

impl Vendor for V {
    type Slot = Slot;
    type Ext = NoExt;
    type Backend = Jsonl;
    const CLI: &'static Cli = &CLI;
    const OBSERVE: Option<&'static Observe<Self>> = Some(&OBSERVE);
}

const TS: Text<V> = Text::Py(&["timestamp"]);
const LINE_KEY: Text<V> = Text::Concat(&[Text::Lit("act:"), Text::Line]);
const CONTENT: Path = &["message", "content"];
const IS_MESSAGE: Pred<V> = Pred::All(&[Pred::Eq(&["type"], "message"), Pred::IsObject(&["message"])]);
const ASSISTANT: Pred<V> = Pred::Eq(&["message", "role"], "assistant");
/// A real prompt: not a hook's bookkeeping entry, not a tool result filed under the user role.
const PROMPT: Pred<V> = Pred::All(&[
    Pred::Eq(&["message", "role"], "user"),
    Pred::Not(&Pred::Truthy(&["message", "hookEventName"])),
    Pred::Not(&Pred::AnyItem(CONTENT, &Pred::Eq(&["type"], "tool_result"))),
]);

pub static CLI: Cli = Cli {
    key: "droid",
    label: "Droid CLI (Factory)",
    kind: Kind::Cli,
    order: Order { menu: 140, registry: 80 },
    // The interactive command accepts an unknown `--model` and ignores it.
    launch: Launch {
        yolo_args: &["--auto", "high"],
        // FACTORY_HOME_OVERRIDE relocates the whole ~/.factory tree;
        // FACTORY_RUNTIME_SETTINGS_PATH points droid at a settings file for one
        // process (--settings); droid stamps its own children with
        // DROID_PARENT_SESSION_ID, and a pane that inherits it becomes a child
        // of the parent's session instead of starting its own.
        env_strip: &["FACTORY_HOME_OVERRIDE", "FACTORY_RUNTIME_SETTINGS_PATH", "DROID_PARENT_SESSION_ID"],
        ..Launch::of("droid")
    },
    resume: Resume {
        args: Some(&["--resume", "{id}"]),
        parse: Some(ResumeParse {
            programs: &["droid"],
            tokens: Tokens::Whitespace,
            subcommand: &[],
            id_after_subcommand: false,
            flags: &["--resume", "-r"],
            joined: None,
            pick: Pick::Last,
            value: ValueShape::Any,
        }),
    },
    interrupt: b"\x03",
};

static OBSERVE: Observe<V> = Observe {
    file_name: None,
    other_files: OtherFiles::Empty,
    slots: &[
        // The first line's session_start names the cwd; `lastCwd` (where it last ran) wins.
        Seed {
            slot: Slot::Cwd,
            init: SlotInit::Header {
                lines: 1,
                when: Pred::Eq(&["type"], "session_start"),
                field: Text::FirstOf(&[Text::Py(&["lastCwd"]), Text::Py(&["cwd"])]),
                first_line: true,
            },
        },
        Seed { slot: Slot::SessionId, init: SlotInit::FileStem },
    ],
    cwd: Some(Slot::Cwd),
    session: Some(Slot::SessionId),
    cwd_form: Form::Written,
    records: JsonlRecords {
        usage: Some(FileUsage {
            mode: FileMode::Snapshot { suffix: ".settings.json", mark: "droid_tok::" },
            ..FileUsage::per_record(
                &[UsageRule {
                    when: Pred::IsObject(&["tokenUsage"]),
                    effects: &[],
                    reading: Some(Reading {
                        model: Text::Py(&["model"]),
                        cwd: Text::Slot(Slot::Cwd),
                        session_id: Text::Slot(Slot::SessionId),
                        // Cache counters fold into input; thinkingTokens is left out (main's choice).
                        ..Reading::of(
                            Num::Sum(&[
                                Num::Of(&["tokenUsage", "inputTokens"]),
                                Num::Of(&["tokenUsage", "cacheCreationTokens"]),
                                Num::Of(&["tokenUsage", "cacheReadTokens"]),
                            ]),
                            Num::Of(&["tokenUsage", "outputTokens"]),
                            Text::Concat(&[Text::Lit("usage::"), Text::Slot(Slot::SessionId), Text::Lit("::"), Text::TotalIn, Text::Lit("::"), Text::TotalOut]),
                        )
                    }),
                }],
                0,
            )
        }),
        cursor: LineCursor::Lines,
    },
    activity: Activity {
        kept: &[Kept { slot: Slot::Reply, prefix: "droid_text::", form: KeptForm::Text }],
        ..Activity::rules(&[
            // Every outcome closes the turn, whatever its reason (it rides on detail).
            Rule {
                when: Pred::Eq(&["type"], "agent_turn_outcome"),
                effects: &[
                    Emit::done(Text::Concat(&[Text::Lit("turn:"), Text::Line]), Text::Py(&["reason"]), Text::Slot(Slot::Reply), TS).effect(),
                    Effect::Set(Slot::Reply, Text::Lit("")),
                ],
            },
            Rule {
                when: Pred::All(&[IS_MESSAGE, ASSISTANT]),
                effects: &[Effect::Set(Slot::Reply, Text::Blocks(CONTENT, "text")), Emit::active(LINE_KEY, Text::Lit("assistant"), Text::Lit(""), TS).effect()],
            },
            Rule {
                when: Pred::All(&[IS_MESSAGE, Pred::Not(&ASSISTANT), PROMPT]),
                effects: &[
                    Effect::Set(Slot::Reply, Text::Lit("")),
                    Emit::active(LINE_KEY, Text::Lit("user"), Text::UserPrompt(&Text::Blocks(CONTENT, "text")), TS).effect(),
                ],
            },
            // Tool results, hook entries and other roles: activity without text.
            Rule {
                when: Pred::All(&[IS_MESSAGE, Pred::Not(&ASSISTANT), Pred::Not(&PROMPT)]),
                effects: &[Emit::active(LINE_KEY, Text::Lit("user"), Text::Lit(""), TS).effect()],
            },
        ])
    },
    turns: Turns::Inferred,
};
