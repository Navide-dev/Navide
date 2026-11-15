//! Qwen Code. Chats: `~/.qwen/projects/<encoded cwd>/chats[/archive]/<session>.jsonl`.
//! No end-of-turn record: the next real prompt or 8 s of quiet closes a turn.
use crate::decl::*;
use crate::expr::{self, py_space, tag_values, Scope};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug)]
pub struct V;

slots! { Cwd = "cwd", SessionId = "session_id", Reply = "reply" }

/// What only Qwen Code's chats need.
#[derive(Debug, Clone, Copy, Serialize)]
pub enum Ext {
    /// Text, per tool-result part: the id of the background agent or shell
    /// its output says it launched (the token after the CLI's fixed sentence).
    LaunchedId,
    /// Text: the first `<status>` of a recorded task notification.
    Status,
}

impl Vendor for V {
    type Slot = Slot;
    type Ext = Ext;
    type Backend = Jsonl;
    const CLI: &'static Cli = &CLI;
    const OBSERVE: Option<&'static Observe<Self>> = Some(&OBSERVE);

    fn text(ext: Ext, scope: &Scope<'_, Self>) -> String {
        match ext {
            Ext::LaunchedId => {
                let output = scope.get(OUTPUT).and_then(Value::as_str).unwrap_or_default();
                ["Background agent launched successfully.\ntask_id: ", "Background shell started.\nid: "]
                    .iter()
                    .filter_map(|prefix| output.strip_prefix(prefix))
                    .map(|rest| rest.split(py_space).next().unwrap_or_default())
                    .find(|id| !id.is_empty())
                    .unwrap_or_default()
                    .to_owned()
            }
            Ext::Status => tag_values(&expr::text(&PARTS, scope), "status", true).pop().unwrap_or_default(),
        }
    }
}

const TS: Text<V> = Text::Py(&["timestamp"]);
const LINE_KEY: Text<V> = Text::Concat(&[Text::Lit("act:"), Text::Line]);
const BG_KEY: Text<V> = Text::Concat(&[Text::Lit("bg:"), Text::Line]);
/// The joined text of `message.parts[]` (user and assistant records alike).
const PARTS: Text<V> = Text::Join { list: &["message", "parts"], filter: &Pred::IsString(&["text"]), item: &Text::Str(&["text"]), sep: "\n", keep_empty: true };
const OUTPUT: Path = &["functionResponse", "response", "output"];
const SUBTYPE: Text<V> = Text::Py(&["subtype"]);

pub static CLI: Cli = Cli {
    key: "qwen",
    label: "Qwen Code (Alibaba Cloud)",
    kind: Kind::Cli,
    order: Order { menu: 70, registry: 200 },
    launch: Launch { yolo_args: &["--yolo"], model: Some(&["--model", "{}"]), env_strip: &["QWEN_HOME", "QWEN_RUNTIME_DIR"], ..Launch::of("qwen") },
    resume: Resume {
        args: Some(&["--resume", "{id}"]),
        parse: Some(ResumeParse {
            programs: &["qwen"],
            tokens: Tokens::Whitespace,
            subcommand: &[],
            id_after_subcommand: false,
            flags: &["--resume", "-r"],
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
        // Every record carries the cwd: the first parseable one names it.
        Seed { slot: Slot::Cwd, init: SlotInit::Header { lines: 0, when: Pred::True, field: Text::Py(&["cwd"]), first_line: false } },
        Seed { slot: Slot::SessionId, init: SlotInit::FileStem },
    ],
    cwd: Some(Slot::Cwd),
    session: Some(Slot::SessionId),
    cwd_form: Form::Written,
    records: JsonlRecords {
        usage: Some(FileUsage::per_record(
            &[UsageRule {
                when: Pred::All(&[Pred::Eq(&["type"], "assistant"), Pred::IsObject(&["usageMetadata"])]),
                effects: &[],
                reading: Some(Reading {
                    cache_read: Num::Of(&["usageMetadata", "cachedContentTokenCount"]),
                    key_required: true,
                    model: Text::Py(&["model"]),
                    timestamp: TS,
                    cli_version: Text::Py(&["version"]),
                    cwd: Text::Py(&["cwd"]),
                    session_id: Text::Slot(Slot::SessionId),
                    // promptTokenCount already holds the cached part; thoughts fold into output.
                    ..Reading::of(
                        Num::Of(&["usageMetadata", "promptTokenCount"]),
                        Num::Sum(&[Num::Of(&["usageMetadata", "candidatesTokenCount"]), Num::Of(&["usageMetadata", "thoughtsTokenCount"])]),
                        Text::Py(&["uuid"]),
                    )
                }),
            }],
            64,
        )),
        cursor: LineCursor::Lines,
    },
    activity: Activity {
        idle: Some(Idle { after_ms: 8000, clock: Clock::FileMtime, detail: "idle" }),
        turn_text: Some(Slot::Reply),
        kept: &[Kept { slot: Slot::Reply, prefix: "qwen_text::", form: KeptForm::Text }],
        turn_key: Some(TurnKey { prefix: "qwen_turn::", compact: false, keep_null: false }),
        ..Activity::rules(&[
            // Automated user records are not prompts and open no turn.
            Rule {
                when: Pred::All(&[
                    Pred::Eq(&["type"], "user"),
                    Pred::Not(&Pred::Text(SUBTYPE, StrTest::In(&["mid_turn_user_message", "cron", "notification", "agent_mention", "agent_message"]))),
                ]),
                effects: &[
                    Effect::Turn(TurnOp::Open { boundary: "boundary", ts: TS, ms: Num::Zero }),
                    Emit::active(LINE_KEY, Text::Lit("user"), Text::UserPrompt(&PARTS), TS).effect(),
                ],
            },
            Rule {
                when: Pred::Eq(&["type"], "assistant"),
                effects: &[
                    // A resumed session joined mid-turn still opens one.
                    Effect::Turn(TurnOp::EnsureOpen { ts: TS, ms: Num::Zero }),
                    Effect::Turn(TurnOp::Touch { ts: Some(TS), ms: None }),
                    Effect::SetIfNonEmpty(Slot::Reply, Text::Cap(&Text::Strip(&PARTS), 4000)),
                    Emit::active(LINE_KEY, Text::Lit("assistant"), Text::Lit(""), TS).effect(),
                ],
            },
            Rule {
                when: Pred::Eq(&["type"], "tool_result"),
                effects: &[Emit::active(
                    BG_KEY,
                    Text::Lit("background:start"),
                    Text::Join { list: &["message", "parts"], filter: &Pred::IsString(OUTPUT), item: &Text::Ext(Ext::LaunchedId), sep: "\n", keep_empty: false },
                    TS,
                )
                .with_text()
                .effect()],
            },
            // A recorded <task-notification> with a terminal status ends background work.
            Rule {
                when: Pred::All(&[
                    Pred::Eq(&["type"], "user"),
                    Pred::Text(SUBTYPE, StrTest::Eq("notification")),
                    Pred::Text(PARTS, StrTest::Contains("<task-notification>")),
                    Pred::Not(&Pred::Text(Text::Ext(Ext::Status), StrTest::In(&["", "running"]))),
                ]),
                effects: &[Emit::active(BG_KEY, Text::Lit("background:end"), Text::TagValues(&PARTS, "task-id"), TS).with_text().effect()],
            },
        ])
    },
    turns: Turns::Inferred,
};
