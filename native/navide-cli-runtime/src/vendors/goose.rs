//! Goose. One SQLite database for every session:
//! `$GOOSE_PATH_ROOT/data|$XDG_DATA_HOME/goose|~/.local/share/goose` + `/sessions/sessions.db`.
//! `usage_ledger` has a row per model call; `messages` a row per message,
//! and a text-only assistant row of a top-level session ends the turn.
use crate::decl::*;
use crate::expr::{int_at, py_str_opt, Scope};
use crate::time;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug)]
pub struct V;

slots! { Cwd = "cwd", SessionId = "session_id" }

/// What only Goose's store needs.
#[derive(Debug, Clone, Copy, Serialize)]
pub enum Ext {
    /// Text: the row's `created` epoch seconds as ISO-8601.
    Created,
    /// Text: the name of the first tool an assistant message requests.
    ToolName,
    /// Tests: the message's metadata says `false` outright (not merely
    /// nothing) for the agent's, or the user's, view of it.
    AgentHidden,
    UserHidden,
}

impl Vendor for V {
    type Slot = Slot;
    type Ext = Ext;
    type Backend = Sqlite;
    const CLI: &'static Cli = &CLI;
    const OBSERVE: Option<&'static Observe<Self>> = Some(&OBSERVE);

    fn text(ext: Ext, scope: &Scope<'_, Self>) -> String {
        match ext {
            Ext::Created => int_at(scope.record, &["created"]).checked_mul(1_000_000).map(time::iso_from_micros).unwrap_or_default(),
            Ext::ToolName => scope
                .get(CONTENT)
                .and_then(Value::as_array)
                .and_then(|items| items.iter().find(|item| item.get("type").and_then(Value::as_str) == Some("toolRequest")))
                .map(|item| py_str_opt(crate::expr::get(item, &["toolCall", "value", "name"])))
                .unwrap_or_default(),
            Ext::AgentHidden | Ext::UserHidden => String::new(),
        }
    }

    fn pred(ext: Ext, scope: &Scope<'_, Self>) -> bool {
        let is_false = |key: &str| scope.get(&["meta", key]) == Some(&Value::Bool(false));
        match ext {
            Ext::AgentHidden => is_false("agentVisible"),
            Ext::UserHidden => is_false("userVisible"),
            Ext::Created | Ext::ToolName => false,
        }
    }
}

const TS: Text<V> = Text::Ext(Ext::Created);
const CONTENT: Path = &["content"];
const TOOL_REQUEST: Pred<V> = Pred::AnyItem(CONTENT, &Pred::Eq(&["type"], "toolRequest"));
const TOOL_RESPONSE: Pred<V> = Pred::AnyItem(CONTENT, &Pred::Eq(&["type"], "toolResponse"));
const ACTION_REQUIRED: Pred<V> = Pred::AnyItem(CONTENT, &Pred::Eq(&["type"], "actionRequired"));
/// main's `_text_of`: the stripped, non-empty text blocks, one per line.
const TEXT: Text<V> = Text::Join { list: CONTENT, filter: &Pred::Eq(&["type"], "text"), item: &Text::Strip(&Text::Py(&["text"])), sep: "\n", keep_empty: false };
const ASSISTANT: Pred<V> = Pred::Eq(&["role"], "assistant");
const USER: Pred<V> = Pred::Eq(&["role"], "user");
const REPLY: Pred<V> = Pred::All(&[ASSISTANT, Pred::Text(TEXT, StrTest::NonEmpty), Pred::Not(&Pred::Ext(Ext::AgentHidden))]);
const KEY: Text<V> = Text::Concat(&[Text::Lit("message:"), Text::Num(&Num::Of(&["id"]))]);

/// Every row is one event; the first rule that matches it decides which.
const fn active(detail: Str) -> [Effect<V>; 2] {
    Emit::active(KEY, Text::Lit(detail), Text::Lit(""), TS).last()
}

pub static CLI: Cli = Cli {
    key: "goose",
    label: "Goose (AAIF)",
    kind: Kind::Cli,
    order: Order { menu: 160, registry: 90 },
    // Approval is the GOOSE_MODE setting, not a flag.
    launch: Launch::of("goose"),
    resume: Resume {
        args: Some(&["session", "-r", "--session-id", "{id}"]),
        parse: Some(ResumeParse {
            programs: &["goose"],
            tokens: Tokens::Whitespace,
            subcommand: &["session", "s"],
            id_after_subcommand: false,
            flags: &["--session-id"],
            joined: Some(ValueShape::NoDash),
            pick: Pick::First,
            value: ValueShape::NoDash,
        }),
    },
    interrupt: b"\x03",
};

static OBSERVE: Observe<V> = Observe {
    file_name: Some("sessions.db"),
    other_files: OtherFiles::Empty,
    slots: &[],
    cwd: Some(Slot::Cwd),
    session: Some(Slot::SessionId),
    cwd_form: Form::Written,
    records: SqliteRecords {
        json: &["content", "meta"],
        binary: &[],
        requires: &[],
        unreadable: Unreadable::Quiet,
        seeds: &[],
        usage: SqlUsage::After {
            rules: &[UsageRule {
                when: Pred::True,
                effects: &[],
                reading: Some(Reading {
                    cache_read: Num::Of(&["cache_read"]),
                    cache_creation: Num::Of(&["cache_write"]),
                    model: Text::Py(&["model"]),
                    timestamp: TS,
                    cwd: Text::Py(&["cwd"]),
                    session_id: Text::Py(&["session_id"]),
                    raw: &[(&["row_id"], RawValue::Num(Num::Of(&["id"])))],
                    ..Reading::of(Num::Of(&["input"]), Num::Of(&["output"]), Text::Concat(&[Text::Lit("usage:"), Text::Num(&Num::Of(&["id"]))]))
                }),
            }],
            sql: "SELECT u.id AS id, u.session_id AS session_id, u.created_timestamp AS created, COALESCE(u.model, '') AS model, \
                  u.input_tokens AS input, u.output_tokens AS output, u.cache_read_tokens AS cache_read, \
                  u.cache_write_tokens AS cache_write, COALESCE(s.working_dir, '') AS cwd \
                  FROM usage_ledger u JOIN sessions s ON s.id = u.session_id WHERE u.id > ? ORDER BY u.id",
            id: "id",
        },
        activity: SqlWalk::Rows(RowWalk {
            sql: "SELECT m.id AS id, m.session_id AS session_id, m.role AS role, m.content_json AS content, \
                  m.metadata_json AS meta, m.created_timestamp AS created, COALESCE(s.working_dir, '') AS cwd, \
                  s.parent_session_id AS parent, s.session_type AS session_type \
                  FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.id > ? ORDER BY m.id LIMIT ?",
            id: "id",
            newest: "SELECT COALESCE(MAX(id), 0) FROM messages",
            page: 256,
            first_sight: FirstSight::Newest,
            shrink: Shrink::Ignore,
            hold_last: None,
            revisit: None,
            last_as: None,
            key: "goose_message::",
        }),
    },
    activity: Activity::rules(&[
        // Each row names its own session and cwd.
        Rule { when: Pred::True, effects: &[Effect::Set(Slot::Cwd, Text::Py(&["cwd"])), Effect::Set(Slot::SessionId, Text::Py(&["session_id"]))] },
        Rule {
            when: Pred::All(&[ASSISTANT, TOOL_REQUEST]),
            effects: &Emit::active(
                KEY,
                Text::Concat(&[Text::Lit("tool:"), Text::FirstOf(&[Text::Ext(Ext::ToolName), Text::Lit("unknown")])]),
                Text::Lit(""),
                TS,
            )
            .last(),
        },
        Rule { when: Pred::All(&[ASSISTANT, ACTION_REQUIRED]), effects: &active("assistant:action-required") },
        // A sub-agent finished; its parent is still working.
        Rule {
            when: Pred::All(&[REPLY, Pred::Any(&[Pred::Truthy(&["parent"]), Pred::Not(&Pred::Eq(&["session_type"], "user"))])]),
            effects: &active("subagent:done"),
        },
        Rule { when: REPLY, effects: &Emit::done(KEY, Text::Lit("assistant"), TEXT, TS).last() },
        Rule { when: ASSISTANT, effects: &active("assistant") },
        Rule { when: Pred::All(&[USER, TOOL_RESPONSE]), effects: &active("tool:result") },
        Rule { when: Pred::All(&[USER, ACTION_REQUIRED]), effects: &active("user:action-response") },
        // The CLI's own injected context is not typed.
        Rule { when: Pred::All(&[USER, Pred::Any(&[Pred::Truthy(&["meta", "turnContext"]), Pred::Ext(Ext::UserHidden)])]), effects: &active("user:context") },
        Rule { when: USER, effects: &Emit::active(KEY, Text::Lit("user"), Text::UserPrompt(&TEXT), TS).last() },
        Rule { when: Pred::True, effects: &Emit::active(KEY, Text::FirstOf(&[Text::Py(&["role"]), Text::Lit("message")]), Text::Lit(""), TS).last() },
    ]),
    turns: Turns::Inferred,
};
