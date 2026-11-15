//! OpenCode (Anomaly). One SQLite database for every project and session,
//! `$XDG_DATA_HOME|~/.local/share` + `/opencode/opencode.db`, in one of two
//! schemas:
//!
//! * 1.x: `session`, `message` (the message JSON; an assistant row is
//!   rewritten in place while it streams, and counts once `time.completed`
//!   lands) and `part` (append-only content blocks; a `step-finish` part
//!   with reason `stop` ends the turn).
//! * OpenCode 2: `session_v2` and `session_message` (one row per message; an
//!   `idle` message ends the turn). An upgraded database still holds the 1.x
//!   tables, frozen.
//!
//! Which one a database holds is told by its tables on every read
//! (`Ext::Schema`), and what that probe finds goes to the reader's
//! read-problem registry, which the CLI's status shows. A query that fails
//! is not reported from here: the call answers `Unsupported`, and main's
//! reader makes the same read and records why in its own words.
//!
//! Kilo Code is a fork with the same store under another name, so the whole
//! declaration is `store!`, written once and expanded for each of the two.
use crate::decl::*;
use crate::expr::{py_int, py_str_opt, Scope};
use crate::time;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;

/// What only this store needs.
#[derive(Debug, Clone, Copy, Serialize)]
pub enum Ext {
    /// Probe: which schema the database holds (`V1` or `V2`).
    Schema,
    /// Text: the row's `created` epoch milliseconds as ISO-8601.
    Created,
}

/// The variants a declaration lists, in this order.
pub const V1: usize = 0;
pub const V2: usize = 1;

const TABLES: &str = "SELECT name FROM sqlite_master WHERE type = 'table'";
/// The newest write on each side of a database that holds both schemas.
/// OpenCode 2's migration copies `time_updated` across, so only a 1.x binary
/// still writing makes the 1.x side newer.
const NEWEST_WRITES: &str = "SELECT (SELECT COALESCE(MAX(time_updated), 0) FROM message) AS v1, \
     (SELECT COALESCE(MAX(time_updated), 0) FROM session_message) AS v2";

fn found(pick: Option<usize>, problem: Option<Problem>) -> Probed {
    Probed { pick, read: Some(Read { key: "schema", problem }) }
}

/// main's `_schema`. OpenCode 2's tables win, unless the 1.x ones took the
/// newest write (a downgrade, or a 1.x binary sharing the database): that is
/// read as 1.x and disclosed, since the 2.x side then goes unread.
pub fn schema<S: FnMut(&str) -> Option<Vec<Value>>>(store: &mut S) -> Probed {
    let Some(rows) = store(TABLES) else { return Probed { pick: None, read: None } };
    let names: BTreeSet<String> = rows.iter().map(|row| py_str_opt(row.get("name"))).collect();
    let has = |table: &str| names.contains(table);
    let v2 = ["session_message", "session_v2"];
    if v2.iter().all(|table| has(table)) {
        let newest = if has("message") { store(NEWEST_WRITES) } else { None };
        if newest.as_deref().and_then(<[Value]>::first).is_some_and(|row| py_int(row.get("v1")) > py_int(row.get("v2"))) {
            let detail = "both OpenCode 1.x and OpenCode 2 tables are present and the 1.x ones were written last; \
                          reading the 1.x tables, OpenCode 2 sessions are not seen";
            return found(Some(V1), Some(Problem { status: "partial", reason: "mixed-schema", detail: detail.to_owned() }));
        }
        return found(Some(V2), None);
    }
    if has("session") {
        let (there, missing): (Vec<&str>, Vec<&str>) = v2.iter().partition(|table| has(table));
        if there.is_empty() {
            return found(Some(V1), None);
        }
        let detail = format!("OpenCode 2 table(s) {} without {}; reading the 1.x tables", there.join(", "), missing.join(", "));
        return found(Some(V1), Some(Problem { status: "partial", reason: "partial-v2-schema", detail }));
    }
    let tables = if names.is_empty() { "none".to_owned() } else { names.into_iter().collect::<Vec<_>>().join(", ") };
    found(None, Some(Problem { status: "unreadable", reason: "unrecognized-schema", detail: format!("tables: {tables}") }))
}

/// `_epoch_to_iso(_int(created_ms) / 1000) or ""`.
pub fn created<V: Vendor>(scope: &Scope<'_, V>) -> String {
    time::iso_from_float(py_int(scope.get(&["created"])) as f64 / 1000.0)
}

/// The rows of a message table after a rowid (`?1`), with the ones still
/// streaming (`?2`, a JSON list of rowids), oldest first. `$data` is the
/// message JSON in 1.x's shape.
macro_rules! messages {
    ($data:literal, $message:literal, $session:literal) => {
        concat!(
            "SELECT m.rowid AS row, m.id AS id, m.session_id AS session_id, ",
            $data,
            " AS data, COALESCE(s.directory, '') AS cwd FROM ",
            $message,
            " m JOIN ",
            $session,
            " s ON s.id = m.session_id WHERE m.rowid > ?1 OR m.rowid IN (SELECT value FROM json_each(?2)) ORDER BY m.rowid"
        )
    };
}

pub const V1_USAGE: &str = messages!("m.data", "message", "session");
/// `role` is the row's `type` and `modelID` is `data.model.id`, so one rule
/// reads both schemas.
pub const V2_USAGE: &str =
    messages!("json_set(m.data, '$.role', m.type, '$.modelID', json_extract(m.data, '$.model.id'))", "session_message", "session_v2");

/// One event per new `part` row. A turn's end carries the reply: the
/// message's parts in order (a part that is not JSON reads as nothing).
pub const V1_ACTIVITY: &str = "SELECT p.rowid AS id, p.session_id AS session_id, p.data AS part, m.data AS message, \
     COALESCE(s.directory, '') AS cwd, s.parent_id AS parent, p.time_created AS created, 'part' AS source, \
     CASE WHEN json_valid(p.data) AND json_extract(p.data, '$.type') = 'step-finish' AND json_extract(p.data, '$.reason') = 'stop' \
     THEN (SELECT json_group_array(json(CASE WHEN json_valid(x.data) THEN x.data ELSE 'null' END)) \
     FROM (SELECT data FROM part WHERE message_id = p.message_id ORDER BY rowid) x) END AS reply \
     FROM part p JOIN message m ON m.id = p.message_id JOIN session s ON s.id = p.session_id \
     WHERE p.rowid > ?1 ORDER BY p.rowid LIMIT ?2";

/// One event per new message row (OpenCode 2 has no append-only part table).
/// A turn's end carries the last assistant step before its `idle` message.
pub const V2_ACTIVITY: &str = "SELECT m.rowid AS id, m.session_id AS session_id, m.type AS type, m.data AS data, \
     COALESCE(s.directory, '') AS cwd, s.parent_id AS parent, m.time_created AS created, 'message' AS source, \
     CASE WHEN m.type = 'idle' THEN (SELECT x.data FROM session_message x \
     WHERE x.session_id = m.session_id AND x.type = 'assistant' AND x.seq < m.seq ORDER BY x.seq DESC LIMIT 1) END AS reply \
     FROM session_message m JOIN session_v2 s ON s.id = m.session_id \
     WHERE m.rowid > ?1 ORDER BY m.rowid LIMIT ?2";

/// The declaration of one CLI of this family: `$cli` is its `Cli`, `$db` the
/// database's file name. The file that expands it has `crate::decl::*` in
/// scope.
macro_rules! store {
    ($cli:ident, $db:literal) => {
        use $crate::vendors::opencode as family;

        #[derive(Debug)]
        pub struct V;

        slots! { Cwd = "cwd", SessionId = "session_id" }

        impl Vendor for V {
            type Slot = Slot;
            type Ext = family::Ext;
            type Backend = Sqlite;
            const CLI: &'static Cli = &$cli;
            const OBSERVE: Option<&'static Observe<Self>> = Some(&OBSERVE);

            fn text(ext: family::Ext, scope: &$crate::expr::Scope<'_, Self>) -> String {
                match ext {
                    family::Ext::Created => family::created(scope),
                    family::Ext::Schema => String::new(),
                }
            }

            fn probe<S: FnMut(&str) -> Option<Vec<serde_json::Value>>>(ext: family::Ext, store: &mut S) -> Probed {
                match ext {
                    family::Ext::Schema => family::schema(store),
                    family::Ext::Created => Probed { pick: None, read: None },
                }
            }
        }

        const ID: Text<V> = Text::Num(&Num::Of(&["id"]));
        const TS: Text<V> = Text::Ext(family::Ext::Created);
        const ASSISTANT: Pred<V> = Pred::Eq(&["data", "role"], "assistant");
        /// `time.completed` (epoch ms): 0 while the message streams.
        const COMPLETED: Num<V> = Num::Of(&["data", "time", "completed"]);

        /// A completed assistant message, cache folded into input and
        /// reasoning into output. The same rule reads both schemas.
        const USAGE: &[UsageRule<V>] = &[UsageRule {
            when: ASSISTANT,
            effects: &[],
            reading: Some(Reading {
                model: Text::Py(&["data", "modelID"]),
                timestamp: Text::Num(&COMPLETED),
                cli_version: Text::Py(&["version"]),
                cwd: Text::Py(&["cwd"]),
                session_id: Text::Py(&["session_id"]),
                ..Reading::of(
                    Num::Sum(&[Num::Of(&["data", "tokens", "input"]), Num::Of(&["data", "tokens", "cache", "read"]), Num::Of(&["data", "tokens", "cache", "write"])]),
                    Num::Sum(&[Num::Of(&["data", "tokens", "output"]), Num::Of(&["data", "tokens", "reasoning"])]),
                    Text::Concat(&[Text::Lit("msg:"), Text::Py(&["id"])]),
                )
            }),
        }];

        /// The message table's rowid is the watermark (its id is text), and
        /// the row's immutable columns are the anchor (`data` is rewritten
        /// while a message streams).
        const fn messages(sql: Str, table_newest: Str, anchor_sql: Str, versions: Str, tag: Option<(Str, Str)>) -> SqlUsage<V> {
            SqlUsage::Anchored(Anchored {
                settling: Some(Settling { when: Pred::All(&[ASSISTANT, Pred::Text(Text::Num(&COMPLETED), StrTest::Eq("0"))]), cap: 64 }),
                tag,
                // `session.version`, which older CLIs' schema lacks.
                lookup: Some(Lookup { sql: versions, by: "session_id", column: "version" }),
                ..Anchored::of(USAGE, sql, "row", table_newest, anchor_sql, &["id", "session_id"])
            })
        }

        /// First sight of the database: everything in it is history.
        const fn rows(sql: Str, newest: Str, key: Str) -> RowWalk<V> {
            RowWalk { sql, id: "id", newest, page: 256, first_sight: FirstSight::Newest, shrink: Shrink::Ignore, hold_last: None, revisit: None, last_as: None, key }
        }

        const PART: Pred<V> = Pred::Eq(&["source"], "part");
        const PART_KEY: Text<V> = Text::Concat(&[Text::Lit("part:"), ID]);
        const MESSAGE_KEY: Text<V> = Text::Concat(&[Text::Lit("message:"), ID]);
        const PART_TYPE: Text<V> = Text::Py(&["part", "type"]);
        const fn part(kind: Str) -> Pred<V> {
            Pred::Text(PART_TYPE, StrTest::Eq(kind))
        }
        const MESSAGE_TYPE: Text<V> = Text::Py(&["type"]);
        const SUBAGENT: Pred<V> = Pred::Truthy(&["parent"]);
        const TEXT_BLOCK: Pred<V> = Pred::Eq(&["type"], "text");
        const BLOCK_TEXT: Text<V> = Text::Strip(&Text::Py(&["text"]));
        const fn active(key: Text<V>, detail: Text<V>) -> [Effect<V>; 2] {
            Emit::active(key, detail, Text::Lit(""), TS).last()
        }
        const fn prompt(key: Text<V>, text: &'static Text<V>) -> [Effect<V>; 2] {
            Emit::active(key, Text::Lit("user"), Text::UserPrompt(text), TS).last()
        }
        /// The turn's reply: the stripped, non-empty text blocks, one per line.
        const fn done(key: Text<V>, reply: Path) -> [Effect<V>; 2] {
            let text = Text::Join { list: reply, filter: &TEXT_BLOCK, item: &BLOCK_TEXT, sep: "\n", keep_empty: false };
            Emit::done(key, Text::Lit("assistant"), text, TS).last()
        }

        static OBSERVE: Observe<V> = Observe {
            file_name: Some($db),
            // Sibling files (auth.json, legacy storage) carry no sessions.
            other_files: OtherFiles::Empty,
            slots: &[],
            cwd: Some(Slot::Cwd),
            session: Some(Slot::SessionId),
            cwd_form: Form::Written,
            records: SqliteRecords {
                json: &["data", "part", "message", "reply"],
                binary: &[],
                requires: &[],
                // main's reader records why (its read-problem registry).
                unreadable: Unreadable::Unsupported,
                seeds: &[],
                usage: SqlUsage::OneOf {
                    probe: family::Ext::Schema,
                    of: &[
                        messages(
                            family::V1_USAGE,
                            "SELECT COALESCE(MAX(rowid), 0) FROM message",
                            "SELECT id, session_id FROM message WHERE rowid = ?",
                            "SELECT id AS key, version AS value FROM session",
                            None,
                        ),
                        messages(
                            family::V2_USAGE,
                            "SELECT COALESCE(MAX(rowid), 0) FROM session_message",
                            "SELECT id, session_id FROM session_message WHERE rowid = ?",
                            "SELECT id AS key, version AS value FROM session_v2",
                            Some(("schema", "v2")),
                        ),
                    ],
                },
                activity: SqlWalk::OneOf {
                    probe: family::Ext::Schema,
                    of: &[
                        // An empty `part` table leaves no mark; an empty
                        // `session_message` is a mark of 0, or its first
                        // messages would be skipped as history.
                        SqlWalk::Tables(&[rows(family::V1_ACTIVITY, "SELECT MAX(rowid) FROM part", "opencode_part::")]),
                        SqlWalk::Tables(&[rows(family::V2_ACTIVITY, "SELECT COALESCE(MAX(rowid), 0) FROM session_message", "opencode_message::")]),
                    ],
                },
            },
            activity: Activity::rules(&[
                // Each row names its own session and cwd.
                Rule { when: Pred::True, effects: &[Effect::Set(Slot::Cwd, Text::Py(&["cwd"])), Effect::Set(Slot::SessionId, Text::Py(&["session_id"]))] },
                // 1.x: `tool-calls` is a pause to run something, not the end of a turn.
                Rule {
                    when: Pred::All(&[PART, part("step-finish"), Pred::Not(&Pred::Text(Text::Py(&["part", "reason"]), StrTest::Eq("stop")))]),
                    effects: &active(PART_KEY, Text::Concat(&[Text::Lit("step-finish:"), Text::FirstOf(&[Text::Py(&["part", "reason"]), Text::Lit("unknown")])])),
                },
                // A subagent finished; its parent, in the same directory, is still working.
                Rule { when: Pred::All(&[PART, part("step-finish"), SUBAGENT]), effects: &active(PART_KEY, Text::Lit("subagent:done")) },
                Rule { when: Pred::All(&[PART, part("step-finish")]), effects: &done(PART_KEY, &["reply"]) },
                Rule {
                    when: Pred::All(&[PART, part("tool")]),
                    effects: &active(PART_KEY, Text::Concat(&[Text::Lit("tool:"), Text::FirstOf(&[Text::Py(&["part", "tool"]), Text::Lit("unknown")])])),
                },
                Rule {
                    when: Pred::All(&[PART, part("text"), Pred::Text(Text::Py(&["message", "role"]), StrTest::Eq("user"))]),
                    effects: &prompt(PART_KEY, &Text::Py(&["part", "text"])),
                },
                Rule { when: Pred::All(&[PART, part("reasoning")]), effects: &active(PART_KEY, Text::Lit("assistant:thinking")) },
                Rule { when: Pred::All(&[PART, part("text")]), effects: &active(PART_KEY, Text::Lit("assistant")) },
                Rule { when: PART, effects: &active(PART_KEY, Text::FirstOf(&[PART_TYPE, Text::Lit("part")])) },
                // OpenCode 2: an `idle` message ends the turn.
                Rule { when: Pred::All(&[Pred::Eq(&["type"], "idle"), SUBAGENT]), effects: &active(MESSAGE_KEY, Text::Lit("subagent:done")) },
                Rule { when: Pred::Eq(&["type"], "idle"), effects: &done(MESSAGE_KEY, &["reply", "content"]) },
                Rule { when: Pred::Eq(&["type"], "user"), effects: &prompt(MESSAGE_KEY, &Text::Py(&["data", "text"])) },
                Rule { when: Pred::Eq(&["type"], "assistant"), effects: &active(MESSAGE_KEY, Text::Lit("assistant")) },
                Rule { when: Pred::True, effects: &active(MESSAGE_KEY, Text::FirstOf(&[MESSAGE_TYPE, Text::Lit("message")])) },
            ]),
            turns: Turns::Inferred,
        };
    };
}

pub(crate) use store;

pub static CLI: Cli = Cli {
    key: "opencode",
    label: "OpenCode (Anomaly)",
    kind: Kind::Cli,
    order: Order { menu: 60, registry: 170 },
    // Only `opencode run` has a permission bypass; the TUI has none.
    launch: Launch { model: Some(&["--model", "{}"]), env_strip: &["OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG"], ..Launch::of("opencode") },
    resume: Resume {
        args: Some(&["--session", "{id}"]),
        parse: Some(ResumeParse {
            programs: &["opencode"],
            tokens: Tokens::Whitespace,
            subcommand: &[],
            id_after_subcommand: false,
            flags: &["--session", "-s"],
            joined: None,
            pick: Pick::Last,
            value: ValueShape::NoDash,
        }),
    },
    interrupt: b"\x03",
};

store!(CLI, "opencode.db");
