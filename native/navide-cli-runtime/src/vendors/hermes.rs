//! Hermes Agent. One SQLite store, `$HERMES_HOME|~/.hermes/state.db`.
//! Tokens are the growth of per-session counters (no per-call rows, so no
//! turns); activity is one event per new `messages` row, and an assistant row
//! with a final `finish_reason` ends the turn. A session's id is its
//! lineage's Navide name (`navide-…`), found up to eight parents up.
use crate::decl::*;
use crate::expr::{py_float, py_str_opt, py_strip, Scope};
use crate::time;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug)]
pub struct V;

slots! { Cwd = "cwd", SessionId = "session_id" }

/// What only Hermes's store needs.
#[derive(Debug, Clone, Copy, Serialize)]
pub enum Ext {
    /// Text: the lineage's Navide name (the first of the row's `titles`
    /// that is one), else the session's own id.
    Session,
    /// Text: the row's `ts` (float epoch seconds) as ISO-8601.
    Stamp,
}

impl Vendor for V {
    type Slot = Slot;
    type Ext = Ext;
    type Backend = Sqlite;
    const CLI: &'static Cli = &CLI;
    const OBSERVE: Option<&'static Observe<Self>> = Some(&OBSERVE);

    fn text(ext: Ext, scope: &Scope<'_, Self>) -> String {
        match ext {
            Ext::Session => scope
                .get(&["titles"])
                .and_then(Value::as_array)
                .and_then(|titles| titles.iter().filter_map(Value::as_str).map(session_name).find(|name| !name.is_empty()))
                .map(str::to_owned)
                .unwrap_or_else(|| py_str_opt(scope.get(&["sid"]))),
            Ext::Stamp => py_float(scope.get(&["ts"])).map(time::iso_from_float).unwrap_or_default(),
        }
    }
}

/// Hermes names a continued session `<name> #<n>` (main reads the name with
/// ` #\d+$`). Only a Navide-started name (`navide-…`) counts.
fn session_name(title: &str) -> &str {
    let title = py_strip(title);
    let name = match title.rfind(" #") {
        Some(at) if at + 2 < title.len() && title[at + 2..].chars().all(char::is_numeric) => &title[..at],
        _ => title,
    };
    if name.starts_with("navide-") { name } else { "" }
}

/// `l0` (the row's own session) and its parents `l1`…`l7`; a chain stops at a
/// session without a parent.
macro_rules! lineage {
    () => {
        "LEFT JOIN sessions l1 ON l1.id = l0.parent_session_id AND l0.parent_session_id != '' \
         LEFT JOIN sessions l2 ON l2.id = l1.parent_session_id AND l1.parent_session_id != '' \
         LEFT JOIN sessions l3 ON l3.id = l2.parent_session_id AND l2.parent_session_id != '' \
         LEFT JOIN sessions l4 ON l4.id = l3.parent_session_id AND l3.parent_session_id != '' \
         LEFT JOIN sessions l5 ON l5.id = l4.parent_session_id AND l4.parent_session_id != '' \
         LEFT JOIN sessions l6 ON l6.id = l5.parent_session_id AND l5.parent_session_id != '' \
         LEFT JOIN sessions l7 ON l7.id = l6.parent_session_id AND l6.parent_session_id != '' "
    };
}
macro_rules! titles {
    () => {
        "json_array(l0.title, l1.title, l2.title, l3.title, l4.title, l5.title, l6.title, l7.title) AS titles"
    };
}

const SESSION: Text<V> = Text::Ext(Ext::Session);
/// `messages.content` is plain text, or a JSON list of content blocks.
const MESSAGE: Text<V> = Text::Concat(&[
    Text::If(&Pred::All(&[Pred::IsString(&["content"]), Pred::IsList(&["blocks"])]), &Text::Blocks(&["blocks"], "text")),
    Text::If(&Pred::Not(&Pred::IsList(&["blocks"])), &Text::Str(&["content"])),
]);
const ASSISTANT: Pred<V> = Pred::Eq(&["role"], "assistant");
const TS: Text<V> = Text::Ext(Ext::Stamp);
const KEY: Text<V> = Text::Concat(&[Text::Lit("msg:"), Text::Num(&Num::Of(&["id"]))]);

pub static CLI: Cli = Cli {
    key: "hermes",
    label: "Hermes Agent",
    kind: Kind::Agent,
    order: Order { menu: 200, registry: 110 },
    // Every pane launches through `--continue`, which refuses `-m` / `--reasoning`.
    launch: Launch { base_args: &["chat"], yolo_args: &["--yolo"], ..Launch::of("hermes") },
    resume: Resume {
        args: Some(&["--continue", "{id}"]),
        parse: Some(ResumeParse {
            programs: &["hermes"],
            tokens: Tokens::Literal,
            subcommand: &[],
            id_after_subcommand: false,
            flags: &["-c", "--continue"],
            // Only a Navide-started session name. A continuation's name
            // (`<name> #<n>`) never gets here: `#` is a shell metacharacter,
            // so such a command is not a literal invocation.
            joined: Some(ValueShape::Prefix("navide-")),
            pick: Pick::First,
            value: ValueShape::Prefix("navide-"),
        }),
    },
    interrupt: b"\x03",
};

static OBSERVE: Observe<V> = Observe {
    file_name: Some("state.db"),
    other_files: OtherFiles::Empty,
    slots: &[],
    cwd: Some(Slot::Cwd),
    session: Some(Slot::SessionId),
    cwd_form: Form::Written,
    records: SqliteRecords {
        json: &["blocks", "titles"],
        binary: &[],
        requires: &[
            (
                "sessions",
                &["id", "title", "parent_session_id", "cwd", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "last_activity_at"],
            ),
            ("messages", &["id", "session_id", "role", "content", "tool_calls", "timestamp", "finish_reason"]),
        ],
        unreadable: Unreadable::Quiet,
        seeds: &[],
        usage: SqlUsage::Counters {
            rules: &[UsageRule {
                when: Pred::True,
                effects: &[],
                reading: Some(Reading {
                    cache_read: Num::Of(&["delta", "cache_read_tokens"]),
                    cache_creation: Num::Of(&["delta", "cache_write_tokens"]),
                    timestamp: TS,
                    cwd: Text::Py(&["cwd"]),
                    session_id: SESSION,
                    ..Reading::of(
                        Num::Sum(&[Num::Of(&["delta", "input_tokens"]), Num::Of(&["delta", "cache_read_tokens"]), Num::Of(&["delta", "cache_write_tokens"])]),
                        Num::Of(&["delta", "output_tokens"]),
                        Text::Concat(&[Text::Lit("hermes:"), Text::Py(&["sid"]), Text::Lit(":"), Text::Py(&["counters"])]),
                    )
                }),
            }],
            sql: concat!(
                "SELECT l0.id AS sid, l0.cwd AS cwd, l0.input_tokens AS input_tokens, l0.output_tokens AS output_tokens, ",
                "l0.cache_read_tokens AS cache_read_tokens, l0.cache_write_tokens AS cache_write_tokens, l0.last_activity_at AS ts, ",
                titles!(),
                " FROM sessions l0 ",
                lineage!()
            ),
            id: "sid",
            kind: "hermes_counters",
            map: "sessions",
            columns: &["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"],
        },
        activity: SqlWalk::Rows(RowWalk {
            sql: concat!(
                "SELECT m.id AS id, m.session_id AS sid, m.role AS role, m.content AS content, m.content AS blocks, ",
                "m.tool_calls AS tool_calls, m.timestamp AS ts, m.finish_reason AS finish, l0.cwd AS cwd, ",
                titles!(),
                " FROM messages m LEFT JOIN sessions l0 ON l0.id = m.session_id ",
                lineage!(),
                "WHERE m.id > ? ORDER BY m.id LIMIT ?"
            ),
            id: "id",
            newest: "SELECT COALESCE(MAX(id), 0) FROM messages",
            page: 512,
            first_sight: FirstSight::Newest,
            // A replaced store starts over at its newest row.
            shrink: Shrink::ToNewest,
            // The newest row is an assistant reply with no finish_reason yet: read
            // it again next pass rather than lose its turn end.
            hold_last: Some(Pred::All(&[ASSISTANT, Pred::Not(&Pred::Truthy(&["finish"])), Pred::Not(&Pred::Truthy(&["tool_calls"]))])),
            revisit: None,
            last_as: None,
            key: "hermes_msg::",
        }),
    },
    activity: Activity::rules(&[
        Rule { when: Pred::True, effects: &[Effect::Set(Slot::Cwd, Text::Py(&["cwd"])), Effect::Set(Slot::SessionId, SESSION)] },
        Rule { when: Pred::Eq(&["role"], "user"), effects: &Emit::active(KEY, Text::Lit("user"), Text::UserPrompt(&MESSAGE), TS).with_text().last() },
        Rule {
            when: Pred::All(&[ASSISTANT, Pred::Truthy(&["finish"]), Pred::Not(&Pred::Eq(&["finish"], "tool_calls")), Pred::Not(&Pred::Truthy(&["tool_calls"]))]),
            effects: &Emit::done(KEY, Text::Py(&["finish"]), Text::Cap(&MESSAGE, 8000), TS).last(),
        },
        Rule { when: Pred::In(&["role"], &["assistant", "tool"]), effects: &Emit::active(KEY, Text::Py(&["role"]), Text::Lit(""), TS).last() },
    ]),
    // Token events are counter growth, not per-call usage: no turns to cut.
    turns: Turns::None,
};

#[cfg(test)]
mod tests {
    use super::session_name;

    #[test]
    fn continued_names_lose_their_counter() {
        assert_eq!(session_name(" navide-abc #12 "), "navide-abc");
        assert_eq!(session_name("navide-abc #x"), "navide-abc #x");
        assert_eq!(session_name("navide-abc #"), "navide-abc #");
        assert_eq!(session_name("my own chat #2"), "");
    }
}
