//! Claude Code. Transcripts: `~/.claude/projects/<encoded cwd>/<session>.jsonl`.
use crate::decl::*;
use crate::expr::Scope;
use crate::observe::dir_name;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug)]
pub struct V;

slots! { Cwd = "cwd", SessionId = "session_id" }

/// What only Claude Code's transcripts need.
#[derive(Debug, Clone, Copy, Serialize)]
pub enum Ext {
    /// Slot: the folder name `-a-b` read back as `/a/b` (lossy; a last resort
    /// for a transcript that names no cwd).
    DashDir,
    /// Test: the message is the CLI's own "[Request interrupted by user…"
    /// note, anywhere in its content tree (a string, or blocks whose `text`
    /// or nested `content` is one).
    Interrupted,
}

impl Vendor for V {
    type Slot = Slot;
    type Ext = Ext;
    type Backend = Jsonl;
    const CLI: &'static Cli = &CLI;
    const OBSERVE: Option<&'static Observe<Self>> = Some(&OBSERVE);

    fn pred(ext: Ext, scope: &Scope<'_, Self>) -> bool {
        match ext {
            Ext::Interrupted => interrupted(scope.get(CONTENT)),
            Ext::DashDir => false,
        }
    }

    fn init(ext: Ext, path: &std::path::Path) -> String {
        match ext {
            Ext::DashDir => {
                let name = dir_name(path, 1);
                if name.starts_with('-') { name.replace('-', "/") } else { String::new() }
            }
            Ext::Interrupted => String::new(),
        }
    }
}

fn interrupted(content: Option<&Value>) -> bool {
    match content {
        Some(Value::String(text)) => text.starts_with("[Request interrupted by user"),
        Some(Value::Array(blocks)) => blocks.iter().filter(|b| b.is_object()).any(|b| {
            let child = if b.get("type").and_then(Value::as_str) == Some("text") { b.get("text") } else { b.get("content") };
            interrupted(child)
        }),
        _ => false,
    }
}

const TS: Text<V> = Text::Py(&["timestamp"]);
const LINE_KEY: Text<V> = Text::Concat(&[Text::Lit("act:"), Text::Line]);
const BG_KEY: Text<V> = Text::Concat(&[Text::Lit("bg:"), Text::Line]);
const USAGE_KEY: Text<V> = Text::Concat(&[Text::Py(&["message", "id"]), Text::Lit("::"), Text::Py(&["requestId"])]);
const CONTENT: Path = &["message", "content"];
const USAGE: Path = &["message", "usage"];

/// A prompt with pasted images: text and image blocks, no tool result.
const PASTED_IMAGES: Pred<V> = Pred::All(&[
    Pred::IsList(CONTENT),
    Pred::AnyItem(CONTENT, &Pred::Eq(&["type"], "image")),
    Pred::Not(&Pred::AnyItem(CONTENT, &Pred::Eq(&["type"], "tool_result"))),
]);

const TYPED_PROMPT: Text<V> = Text::If(
    &Pred::All(&[Pred::Eq(&["type"], "user"), Pred::Not(&Pred::Truthy(&["isCompactSummary"])), Pred::Not(&Pred::Truthy(&["isMeta"]))]),
    &Text::FirstOf(&[
        Text::If(&Pred::IsString(CONTENT), &Text::UserPrompt(&Text::Str(CONTENT))),
        Text::If(&PASTED_IMAGES, &Text::UserPrompt(&Text::Blocks(CONTENT, "text"))),
    ]),
);

/// Ids an assistant message stops with TaskStop (or its older names).
const STOPPED_TASKS: Text<V> = Text::Join {
    list: CONTENT,
    filter: &Pred::All(&[Pred::Eq(&["type"], "tool_use"), Pred::In(&["name"], &["TaskStop", "KillShell", "KillBash"])]),
    item: &Text::FirstOf(&[Text::Py(&["input", "task_id"]), Text::Py(&["input", "shell_id"])]),
    sep: "\n",
    keep_empty: false,
};

/// The id of a task a tool result launched in the background.
const STARTED_TASK: Text<V> = Text::If(
    &Pred::IsObject(&["toolUseResult"]),
    &Text::FirstOf(&[
        Text::Py(&["toolUseResult", "backgroundTaskId"]),
        Text::If(
            &Pred::Any(&[
                Pred::Eq(&["toolUseResult", "status"], "async_launched"),
                Pred::All(&[Pred::Eq(&["toolUseResult", "status"], "forked"), Pred::Truthy(&["toolUseResult", "background"])]),
            ]),
            &Text::Py(&["toolUseResult", "agentId"]),
        ),
    ]),
);

pub static CLI: Cli = Cli {
    key: "claude",
    label: "Claude Code (Anthropic)",
    kind: Kind::Cli,
    order: Order { menu: 10, registry: 30 },
    launch: Launch {
        yolo_args: &["--dangerously-skip-permissions"],
        model: Some(&["--model", "{}"]),
        effort: Some(&["--effort", "{}"]),
        efforts: &["low", "medium", "high", "xhigh", "max"],
        // Claude Code gives the first MCP connect 30s (MCP_TIMEOUT) and stops
        // after three retries; a mass restore slowed /plan-mcp past that and left
        // panes without Navide tools until a manual /mcp (2026-11-12). Verified on
        // 2.1.325 that HTTP servers honor it.
        env_defaults: &[("MCP_TIMEOUT", "120000")],
        // Claude Code stamps its own subprocesses with CLAUDE_CODE_CHILD_SESSION;
        // inherited, a spawned pane silently skips transcript saving.
        env_strip: &["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_CHILD_SESSION"],
        ..Launch::of("claude")
    },
    resume: Resume {
        args: Some(&["--resume", "{id}"]),
        parse: Some(ResumeParse {
            programs: &["claude"],
            tokens: Tokens::Whitespace,
            subcommand: &[],
            id_after_subcommand: false,
            flags: &["--resume"],
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
        Seed {
            slot: Slot::Cwd,
            init: SlotInit::FirstOf(&[
                SlotInit::Header {
                    lines: 50,
                    when: Pred::All(&[Pred::IsString(&["cwd"]), Pred::Truthy(&["cwd"])]),
                    field: Text::Str(&["cwd"]),
                    first_line: false,
                },
                SlotInit::Ext(Ext::DashDir),
            ]),
        },
        Seed { slot: Slot::SessionId, init: SlotInit::FileStem },
    ],
    cwd: Some(Slot::Cwd),
    session: Some(Slot::SessionId),
    // A path typed on macOS can be recorded decomposed; main compares and
    // stores the cwd composed.
    cwd_form: Form::Nfc,
    records: JsonlRecords {
        usage: Some(FileUsage::per_record(
            &[UsageRule {
                when: Pred::All(&[Pred::Eq(&["type"], "assistant"), Pred::IsObject(&["message"]), Pred::IsObject(USAGE)]),
                effects: &[],
                reading: Some(Reading {
                    cache_read: Num::Of(&["message", "usage", "cache_read_input_tokens"]),
                    cache_creation: Num::Of(&["message", "usage", "cache_creation_input_tokens"]),
                    key_invalid: "::",
                    model: Text::Py(&["message", "model"]),
                    timestamp: TS,
                    cli_version: Text::Py(&["version"]),
                    cwd: Text::Slot(Slot::Cwd),
                    session_id: Text::Slot(Slot::SessionId),
                    // The 1-hour TTL share of cache creation, priced differently (cost ledger).
                    raw: &[(&["cache_write_1h"], RawValue::Num(Num::Of(&["message", "usage", "cache_creation", "ephemeral_1h_input_tokens"])))],
                    ..Reading::of(
                        Num::Sum(&[
                            Num::Of(&["message", "usage", "input_tokens"]),
                            Num::Of(&["message", "usage", "cache_read_input_tokens"]),
                            Num::Of(&["message", "usage", "cache_creation_input_tokens"]),
                        ]),
                        Num::Of(&["message", "usage", "output_tokens"]),
                        USAGE_KEY,
                    )
                }),
            }],
            64,
        )),
        cursor: LineCursor::Lines,
    },
    activity: Activity::rules(&[
        Rule {
            when: Pred::Eq(&["type"], "assistant"),
            effects: &[
                Emit::active(LINE_KEY, Text::Lit("assistant"), Text::Lit(""), TS).effect(),
                // AskUserQuestion parks the turn on the user without ending it.
                Effect::When(
                    &Pred::AnyItem(CONTENT, &Pred::All(&[Pred::Eq(&["type"], "tool_use"), Pred::Eq(&["name"], "AskUserQuestion")])),
                    &[Emit::active(Text::Concat(&[Text::Lit("q:"), Text::Line]), Text::Lit("assistant:question"), Text::Lit(""), TS).effect()],
                ),
                Emit::active(BG_KEY, Text::Lit("background:end"), STOPPED_TASKS, TS).with_text().effect(),
                Effect::When(
                    &Pred::Text(Text::Py(&["message", "stop_reason"]), StrTest::Eq("end_turn")),
                    &[Emit::done(Text::Concat(&[Text::Lit("turn:"), Text::Line]), Text::Lit("end_turn"), Text::Blocks(CONTENT, "text"), TS).effect()],
                ),
            ],
        },
        Rule {
            when: Pred::In(&["type"], &["tool_use", "user"]),
            effects: &[
                Emit::active(LINE_KEY, Text::Py(&["type"]), TYPED_PROMPT, TS).effect(),
                Effect::When(
                    &Pred::All(&[Pred::Eq(&["type"], "user"), Pred::IsObject(&["message"]), Pred::Ext(Ext::Interrupted)]),
                    &[Emit::active(Text::Concat(&[Text::Lit("int:"), Text::Line]), Text::Lit("user:interrupted"), Text::Lit(""), TS).effect()],
                ),
                Effect::When(
                    &Pred::Eq(&["type"], "user"),
                    &[Emit::active(BG_KEY, Text::Lit("background:start"), STARTED_TASK, TS).with_text().effect()],
                ),
            ],
        },
        Rule {
            when: Pred::All(&[
                Pred::Eq(&["type"], "queue-operation"),
                Pred::Eq(&["operation"], "enqueue"),
                Pred::IsString(&["content"]),
                Pred::Text(Text::Str(&["content"]), StrTest::Contains("<task-notification>")),
                Pred::Text(Text::Str(&["content"]), StrTest::Contains("<status>")),
            ]),
            effects: &[Emit::active(BG_KEY, Text::Lit("background:end"), Text::TagValues(&Text::Str(&["content"]), "task-id"), TS).with_text().effect()],
        },
    ]),
    turns: Turns::Exact(&ExactTurns {
        slots: &[],
        filter: SessionFilter::Ignore,
        effects: &[],
        skip: Some(Pred::Not(&Pred::IsObject(&["message"]))),
        // One turn per promptId: a prompt's attachments and images are
        // extra user records under the same id.
        open: Some(TurnOpen {
            when: Pred::All(&[Pred::Eq(&["type"], "user"), Pred::Not(&Pred::Has(&["toolUseResult"]))]),
            mode: OpenMode::ByKey(Text::FirstOf(&[Text::Py(&["promptId"]), Text::Concat(&[Text::Lit("line:"), Text::Line])])),
            prompt: Text::Blocks(CONTENT, "text"),
            merge: PromptMerge::Merge,
            started: TS,
        }),
        call: TurnCall {
            when: Pred::All(&[Pred::Eq(&["type"], "assistant"), Pred::IsObject(USAGE)]),
            each: None,
            input: Num::Of(&["message", "usage", "input_tokens"]),
            cache_read: Num::Of(&["message", "usage", "cache_read_input_tokens"]),
            cache_creation: Num::Of(&["message", "usage", "cache_creation_input_tokens"]),
            output: Num::Of(&["message", "usage", "output_tokens"]),
            input_includes_cache: false,
            cumulative: false,
            skip_zero: true,
            key: Some(USAGE_KEY),
            key_invalid: "::",
            model: Text::Py(&["message", "model"]),
            ts: TS,
            cli_version: Text::Py(&["version"]),
            orphan: Orphan::Drop,
        },
        close: None,
        // main opens the transcript strictly for this pass.
        strict_utf8: true,
    }),
};
