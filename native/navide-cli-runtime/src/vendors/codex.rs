//! Codex CLI. Rollouts: `$CODEX_HOME/sessions/Y/M/D/rollout-*.jsonl`, one per
//! session, holding running token totals.
use crate::decl::*;
use crate::expr::{int_at, Scope};
use serde::Serialize;

#[derive(Debug)]
pub struct V;

slots! {
    SessionId = "session_id",
    Cwd = "cwd",
    Subagent = "subagent",
    Model = "model",
    CliVersion = "cli_version",
    MetaSeen = "meta_seen",
    LedgerModel = "ledger_model",
    HeaderSeen = "header_seen",
    Reply = "reply",
}

/// What only Codex's rollouts need.
#[derive(Debug, Clone, Copy, Serialize)]
pub enum Ext {
    /// Test: this walk started past the rollout's first line, so the header
    /// it meets is a replayed ancestor's, not the file's own.
    Resumed,
    /// Number: the session's uncached input, for the cost ledger
    /// (`max(0, input - cached - cache_write)`).
    LedgerInput,
}

impl Vendor for V {
    type Slot = Slot;
    type Ext = Ext;
    type Backend = Jsonl;
    const CLI: &'static Cli = &CLI;
    const OBSERVE: Option<&'static Observe<Self>> = Some(&OBSERVE);

    fn pred(ext: Ext, scope: &Scope<'_, Self>) -> bool {
        matches!(ext, Ext::Resumed) && scope.resumed
    }

    fn num(ext: Ext, scope: &Scope<'_, Self>) -> Option<i64> {
        match ext {
            Ext::LedgerInput => {
                let total = |key: &'static str| int_at(scope.record, &["payload", "info", "total_token_usage", key]);
                Some((total("input_tokens") - total("cached_input_tokens") - total("cache_write_input_tokens")).max(0))
            }
            Ext::Resumed => None,
        }
    }
}

const TS: Text<V> = Text::Py(&["timestamp"]);
const PTYPE: Path = &["payload", "type"];
const TOTALS: Path = &["payload", "info", "total_token_usage"];

/// main reads `rec.get("payload") or {}`: a missing or empty payload counts
/// as an empty object, any other non-object as no payload.
const PAYLOAD: Pred<V> = Pred::Any(&[Pred::IsObject(&["payload"]), Pred::Not(&Pred::Truthy(&["payload"]))]);
const IS_META: Pred<V> = Pred::All(&[Pred::Eq(&["type"], "session_meta"), PAYLOAD]);
const IS_TOKEN_COUNT: Pred<V> = Pred::All(&[Pred::Eq(&["type"], "event_msg"), Pred::Eq(PTYPE, "token_count"), Pred::IsObject(TOTALS)]);

/// A rollout written by a sub-agent: its turns are not the pane's.
const SUBAGENT_META: Pred<V> = Pred::Any(&[
    Pred::Eq(&["payload", "thread_source"], "subagent"),
    Pred::Truthy(&["payload", "parent_thread_id"]),
    Pred::All(&[Pred::IsObject(&["payload", "source"]), Pred::Has(&["payload", "source", "subagent"])]),
]);

/// The user's typed prompt in either rollout shape: a `user_message` event,
/// or an `item_completed` UserMessage whose text blocks carry it.
const IS_PROMPT: Pred<V> = Pred::Any(&[
    Pred::Eq(PTYPE, "user_message"),
    Pred::All(&[Pred::Eq(PTYPE, "item_completed"), Pred::Eq(&["payload", "item", "type"], "UserMessage")]),
]);
const PROMPT: Text<V> = Text::Concat(&[
    Text::If(&Pred::Eq(PTYPE, "user_message"), &Text::Py(&["payload", "message"])),
    Text::If(
        &Pred::Eq(PTYPE, "item_completed"),
        &Text::Join { list: &["payload", "item", "content"], filter: &Pred::Eq(&["type"], "text"), item: &Text::Py(&["text"]), sep: "\n", keep_empty: true },
    ),
]);

/// The first session_meta is the rollout's own (a sub-agent replays its
/// ancestors' after it).
const FIRST_META: Effect<V> = Effect::When(
    &Pred::Not(&Pred::SlotSet(Slot::MetaSeen)),
    &[
        Effect::Set(Slot::MetaSeen, Text::Lit("1")),
        Effect::Set(Slot::Cwd, Text::FirstOf(&[Text::Py(&["payload", "cwd"]), Text::Slot(Slot::Cwd)])),
        Effect::Set(Slot::SessionId, Text::FirstOf(&[Text::Py(&["payload", "id"]), Text::Slot(Slot::SessionId)])),
        Effect::Set(Slot::Model, Text::FirstOf(&[Text::Py(&["payload", "model_provider"]), Text::Py(&["payload", "model"]), Text::Slot(Slot::Model)])),
        Effect::Set(Slot::CliVersion, Text::FirstOf(&[Text::Py(&["payload", "cli_version"]), Text::Slot(Slot::CliVersion)])),
    ],
);

const LINE_KEY: Text<V> = Text::Concat(&[Text::Lit("act:"), Text::Line]);
const TURN_KEY: Text<V> = Text::Concat(&[Text::Lit("turn:"), Text::Line]);
const TURN_END: Pred<V> = Pred::In(PTYPE, &["task_complete", "turn_aborted"]);

pub static CLI: Cli = Cli {
    key: "codex",
    label: "Codex CLI (OpenAI)",
    kind: Kind::Cli,
    order: Order { menu: 20, registry: 40 },
    launch: Launch {
        yolo_args: &["--dangerously-bypass-approvals-and-sandbox"],
        // Effort is a config override (`-c model_reasoning_effort=…`), not a flag.
        model: Some(&["--model", "{}"]),
        env_strip: &["CODEX_HOME"],
        ..Launch::of("codex")
    },
    resume: Resume {
        args: Some(&["resume", "{id}"]),
        parse: Some(ResumeParse {
            programs: &["codex"],
            tokens: Tokens::Whitespace,
            subcommand: &["resume"],
            id_after_subcommand: true,
            flags: &[],
            joined: None,
            pick: Pick::First,
            value: ValueShape::Any,
        }),
    },
    interrupt: b"\x1b",
};

static OBSERVE: Observe<V> = Observe {
    file_name: None,
    other_files: OtherFiles::Empty,
    slots: &[
        Seed { slot: Slot::SessionId, init: SlotInit::FileStem },
        Seed {
            slot: Slot::Cwd,
            init: SlotInit::Header { lines: 5, when: Pred::Eq(&["type"], "session_meta"), field: Text::Py(&["payload", "cwd"]), first_line: false },
        },
        Seed {
            slot: Slot::Subagent,
            init: SlotInit::Header {
                lines: 5,
                when: Pred::Eq(&["type"], "session_meta"),
                field: Text::If(&Pred::All(&[Pred::IsObject(&["payload"]), SUBAGENT_META]), &Text::Lit("1")),
                first_line: false,
            },
        },
    ],
    cwd: Some(Slot::Cwd),
    session: Some(Slot::SessionId),
    cwd_form: Form::Written,
    records: JsonlRecords {
        usage: Some(FileUsage {
            // Usage takes cwd from the rollout's own first session_meta.
            slots: &[Seed { slot: Slot::Cwd, init: SlotInit::Empty }],
            rules: &[
                UsageRule {
                    when: Pred::Eq(&["type"], "turn_context"),
                    effects: &[Effect::SetIfNonEmpty(Slot::LedgerModel, Text::If(&Pred::IsObject(&["payload"]), &Text::Py(&["payload", "model"])))],
                    reading: None,
                },
                UsageRule { when: Pred::Eq(&["type"], "session_meta"), effects: &[Effect::When(&PAYLOAD, &[FIRST_META])], reading: None },
                UsageRule {
                    when: IS_TOKEN_COUNT,
                    effects: &[],
                    reading: Some(Reading {
                        model: Text::Slot(Slot::Model),
                        timestamp: TS,
                        cli_version: Text::Slot(Slot::CliVersion),
                        cwd: Text::Slot(Slot::Cwd),
                        session_id: Text::Slot(Slot::SessionId),
                        // The session's running totals, for the cost ledger.
                        raw: &[
                            (&["ledger_session_totals", "input"], RawValue::Num(Num::Ext(Ext::LedgerInput))),
                            (&["ledger_session_totals", "cache_read"], RawValue::Num(Num::Of(&["payload", "info", "total_token_usage", "cached_input_tokens"]))),
                            (
                                &["ledger_session_totals", "cache_write"],
                                RawValue::Num(Num::Of(&["payload", "info", "total_token_usage", "cache_write_input_tokens"])),
                            ),
                            (&["ledger_session_totals", "output"], RawValue::Num(Num::Of(&["payload", "info", "total_token_usage", "output_tokens"]))),
                            (&["ledger_session_totals", "model"], RawValue::Text(Text::Slot(Slot::LedgerModel))),
                        ],
                        // input_tokens already holds the cached part, output_tokens the reasoning.
                        ..Reading::of(
                            Num::Of(&["payload", "info", "total_token_usage", "input_tokens"]),
                            Num::Of(&["payload", "info", "total_token_usage", "output_tokens"]),
                            Text::Concat(&[
                                Text::Lit("codex_cumulative::"),
                                Text::Slot(Slot::SessionId),
                                Text::Lit("::"),
                                Text::TotalIn,
                                Text::Lit("::"),
                                Text::TotalOut,
                            ]),
                        )
                    }),
                },
            ],
            // Checkpoints without basis 2 counted cached and reasoning tokens twice.
            mode: FileMode::Cumulative { stamp: &[("basis", 2)] },
            persist: &[Slot::Cwd, Slot::Model, Slot::SessionId, Slot::CliVersion, Slot::MetaSeen, Slot::LedgerModel],
            flags: &[Slot::MetaSeen],
            restore: Restore::UnlessReplaced,
        }),
        cursor: LineCursor::Lines,
    },
    activity: Activity {
        kept: &[Kept { slot: Slot::Reply, prefix: "__lasttext__:", form: KeptForm::TextOnChange }],
        ..Activity::rules(&[
            Rule {
                when: Pred::Eq(&["type"], "session_meta"),
                effects: &[
                    Effect::When(
                        &PAYLOAD,
                        &[
                            Effect::Set(Slot::Cwd, Text::FirstOf(&[Text::Py(&["payload", "cwd"]), Text::Slot(Slot::Cwd)])),
                            // When this walk holds the file's own header, it decides.
                            Effect::When(
                                &Pred::All(&[Pred::Not(&Pred::Ext(Ext::Resumed)), Pred::Not(&Pred::SlotSet(Slot::HeaderSeen))]),
                                &[
                                    Effect::Set(Slot::HeaderSeen, Text::Lit("1")),
                                    Effect::SetIfNonEmpty(Slot::Subagent, Text::If(&SUBAGENT_META, &Text::Lit("1"))),
                                ],
                            ),
                        ],
                    ),
                    Effect::Stop,
                ],
            },
            Rule {
                when: Pred::SlotSet(Slot::Subagent),
                effects: &[
                    Effect::When(
                        &Pred::All(&[Pred::Eq(&["type"], "event_msg"), TURN_END]),
                        &[Emit::new(EventKind::SubagentTurnEnd, TURN_KEY, Text::Py(PTYPE), Text::Lit(""), TS).effect()],
                    ),
                    Effect::Stop,
                ],
            },
            Rule { when: Pred::Eq(&["type"], "assistant"), effects: &[Emit::active(LINE_KEY, Text::Lit("assistant"), Text::Lit(""), TS).effect()] },
            Rule {
                when: Pred::All(&[Pred::Eq(&["type"], "response_item"), Pred::Eq(&["payload", "role"], "assistant"), Pred::Eq(PTYPE, "message")]),
                effects: &[Effect::SetIfNonEmpty(Slot::Reply, Text::Blocks(&["payload", "content"], "output_text"))],
            },
            Rule {
                when: Pred::Eq(&["type"], "event_msg"),
                effects: &[
                    Effect::When(&Pred::Eq(PTYPE, "agent_message"), &[Effect::SetIfNonEmpty(Slot::Reply, Text::Py(&["payload", "message"]))]),
                    Emit::active(
                        LINE_KEY,
                        Text::FirstOf(&[Text::If(&IS_PROMPT, &Text::Lit("user_message")), Text::Py(PTYPE)]),
                        Text::If(&IS_PROMPT, &Text::UserPrompt(&PROMPT)),
                        TS,
                    )
                    .effect(),
                    // task_complete is the turn's end (token_count fires per model call).
                    Effect::When(
                        &TURN_END,
                        &[
                            Emit::done(
                                TURN_KEY,
                                Text::Py(PTYPE),
                                Text::If(
                                    &Pred::Eq(PTYPE, "task_complete"),
                                    &Text::FirstOf(&[Text::Slot(Slot::Reply), Text::Py(&["payload", "last_agent_message"])]),
                                ),
                                TS,
                            )
                            .effect(),
                            Effect::Set(Slot::Reply, Text::Lit("")),
                        ],
                    ),
                ],
            },
        ])
    },
    turns: Turns::Exact(&ExactTurns {
        // Like usage, turns name the session from the rollout's own first session_meta.
        slots: &[],
        filter: SessionFilter::File,
        effects: &[Rule { when: IS_META, effects: &[FIRST_META] }],
        skip: Some(Pred::Any(&[Pred::Not(&PAYLOAD), Pred::Not(&Pred::Eq(&["type"], "event_msg"))])),
        open: Some(TurnOpen { when: IS_PROMPT, mode: OpenMode::Each, prompt: PROMPT, merge: PromptMerge::Excerpt, started: TS }),
        call: TurnCall {
            when: IS_TOKEN_COUNT,
            each: None,
            input: Num::Of(&["payload", "info", "total_token_usage", "input_tokens"]),
            cache_read: Num::Of(&["payload", "info", "total_token_usage", "cached_input_tokens"]),
            cache_creation: Num::Zero,
            output: Num::Of(&["payload", "info", "total_token_usage", "output_tokens"]),
            input_includes_cache: true,
            cumulative: true,
            skip_zero: true,
            key: None,
            key_invalid: "",
            model: Text::Slot(Slot::Model),
            ts: TS,
            cli_version: Text::Slot(Slot::CliVersion),
            orphan: Orphan::OwnTurnUntilFirstOpen,
        },
        close: None,
        // main opens the rollout strictly for this pass.
        strict_utf8: true,
    }),
};
