//! Cursor CLI. One SQLite store per session, `~/.cursor/chats/<hash>/<uuid>/store.db`,
//! whose `blobs` table mixes JSON chat messages with protobuf structure nodes
//! (never decoded). No token usage is stored locally, so there is no usage and
//! no turns. Activity is one event per new JSON message: an assistant message
//! ends the turn, a user message counts only when it carries what the person
//! typed (`<user_query>`). The blobs have no time; the sidecar `meta.json`
//! (also the only record of the cwd) stamps the whole pass.
use crate::decl::*;
use crate::expr::{self, py_float, py_space, py_strip, Scope};
use crate::observe::dir_name;
use crate::resume::shaped;
use crate::text::enclosed;
use crate::time;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug)]
pub struct V;

slots! { SessionId = "session_id", Cwd = "cwd", Updated = "updated" }

/// What only Cursor's store needs.
#[derive(Debug, Clone, Copy, Serialize)]
pub enum Ext {
    /// Text: what the person typed, inside Cursor's `<user_query>` wrapper.
    Typed,
    /// Test: the message has that wrapper at all. A user row without it is
    /// the context Cursor injects (rules, transcripts), not a prompt.
    HasQuery,
    /// Test: what was typed is only Navide's own session marker,
    /// `at-pane:<uuid>`, bare or in its `<!-- agent-team-session: … -->`
    /// comment (typed in at spawn; not user activity).
    Marker,
    /// Text: one clock for the whole pass, since the store has no per-row
    /// time: `meta.json`'s `updatedAtMs` (else the walk's now), plus 1 ms per
    /// event already emitted, so two turns of one pass never share a stamp.
    PassClock,
}

const QUERY: (&str, &str) = ("<user_query>", "</user_query>");

fn typed(content: &str) -> Option<&str> {
    enclosed(content, QUERY.0, QUERY.1).map(py_strip)
}

/// `^(?:<!--\s*agent-team-session:\s*)?at-pane:<uuid>(?:\s*-->)?$`.
fn session_marker(value: &str) -> bool {
    let bare = |rest: &str| {
        let Some(rest) = rest.strip_prefix("at-pane:") else { return false };
        let (Some(id), Some(tail)) = (rest.get(..36), rest.get(36..)) else { return false };
        let tail = tail.strip_suffix('\n').unwrap_or(tail);
        shaped(id, ValueShape::Uuid).is_some() && (tail.is_empty() || tail.trim_start_matches(py_space) == "-->")
    };
    let commented = value
        .strip_prefix("<!--")
        .map(|rest| rest.trim_start_matches(py_space))
        .and_then(|rest| rest.strip_prefix("agent-team-session:"))
        .map(|rest| rest.trim_start_matches(py_space));
    commented.is_some_and(bare) || bare(value)
}

impl Vendor for V {
    type Slot = Slot;
    type Ext = Ext;
    type Backend = Sqlite;
    const CLI: &'static Cli = &CLI;
    const OBSERVE: Option<&'static Observe<Self>> = Some(&OBSERVE);

    fn text(ext: Ext, scope: &Scope<'_, Self>) -> String {
        match ext {
            Ext::Typed => typed(&expr::text(&CONTENT, scope)).unwrap_or_default().to_owned(),
            Ext::PassClock => {
                let updated = py_float(Some(&Value::String(scope.slots.get(Slot::Updated).to_owned()))).filter(|ms| *ms != 0.0);
                time::iso_from_float(updated.map_or(scope.now, |ms| ms / 1000.0) + scope.emitted as f64 * 0.001)
            }
            Ext::HasQuery | Ext::Marker => String::new(),
        }
    }

    fn pred(ext: Ext, scope: &Scope<'_, Self>) -> bool {
        let content = expr::text(&CONTENT, scope);
        match ext {
            Ext::HasQuery => typed(&content).is_some(),
            Ext::Marker => typed(&content).is_some_and(session_marker),
            Ext::Typed | Ext::PassClock => false,
        }
    }

    /// A session's store sits in a directory named by its UUID.
    fn accepts(path: &std::path::Path) -> bool {
        shaped(&dir_name(path, 1), ValueShape::Uuid).is_some()
    }
}

const CONTENT: Text<V> = Text::Blocks(&["data", "content"], "text");
const ROLE: Text<V> = Text::Py(&["data", "role"]);
const KEY: Text<V> = Text::Concat(&[Text::Lit("blob:"), Text::Py(&["id"])]);
const CLOCK: Text<V> = Text::Ext(Ext::PassClock);

pub static CLI: Cli = Cli {
    key: "cursor",
    label: "Cursor CLI",
    kind: Kind::Cli,
    order: Order { menu: 110, registry: 60 },
    // Effort is part of the model id (`gpt-5.3-codex-high`).
    launch: Launch { yolo_args: &["--force"], model: Some(&["--model", "{}"]), ..Launch::of("agent") },
    resume: Resume {
        args: Some(&["--resume={id}"]),
        parse: Some(ResumeParse {
            programs: &["agent", "cursor-agent"],
            tokens: Tokens::Whitespace,
            subcommand: &[],
            id_after_subcommand: false,
            flags: &["--resume"],
            joined: Some(ValueShape::Any),
            pick: Pick::Last,
            value: ValueShape::NoDash,
        }),
    },
    interrupt: b"\x03",
};

static OBSERVE: Observe<V> = Observe {
    file_name: Some("store.db"),
    other_files: OtherFiles::Empty,
    slots: &[
        Seed { slot: Slot::SessionId, init: SlotInit::DirName(1) },
        Seed { slot: Slot::Cwd, init: SlotInit::SidecarJson { up: 1, file: "meta.json", keys: &["cwd"] } },
        Seed { slot: Slot::Updated, init: SlotInit::SidecarJson { up: 1, file: "meta.json", keys: &["updatedAtMs"] } },
    ],
    cwd: Some(Slot::Cwd),
    session: Some(Slot::SessionId),
    cwd_form: Form::Written,
    records: SqliteRecords {
        json: &["data"],
        binary: &[],
        requires: &[],
        unreadable: Unreadable::Quiet,
        seeds: &[],
        usage: SqlUsage::None,
        activity: SqlWalk::Rows(RowWalk {
            sql: "SELECT rowid AS row, id, data FROM blobs WHERE rowid > ?1 ORDER BY rowid LIMIT ?2",
            id: "row",
            newest: "SELECT COALESCE(MAX(rowid), 0) FROM blobs",
            page: 512,
            first_sight: FirstSight::Newest,
            // A shrunk store (recreated, vacuumed) re-anchors at its newest row.
            shrink: Shrink::ToNewest,
            hold_last: None,
            revisit: None,
            last_as: None,
            key: "cursor_blob::",
        }),
    },
    activity: Activity::rules(&[
        Rule { when: Pred::Not(&Pred::IsObject(&["data"])), effects: &[Effect::Stop] },
        Rule {
            when: Pred::Text(ROLE, StrTest::Eq("assistant")),
            effects: &Emit::done(KEY, Text::Lit("assistant"), Text::Cap(&CONTENT, 8000), CLOCK).last(),
        },
        Rule {
            when: Pred::All(&[Pred::Text(ROLE, StrTest::Eq("user")), Pred::Ext(Ext::HasQuery), Pred::Not(&Pred::Ext(Ext::Marker))]),
            effects: &Emit::active(KEY, Text::Lit("user"), Text::UserPrompt(&Text::Ext(Ext::Typed)), CLOCK).last(),
        },
    ]),
    // No token usage on disk: no turns to cut.
    turns: Turns::None,
};

#[cfg(test)]
mod tests {
    use super::{session_marker, typed};

    #[test]
    fn markers_and_queries_follow_main() {
        let id = "0198f6a2-71aa-4d02-9c11-2233445566aa";
        assert!(session_marker(&format!("at-pane:{id}")));
        assert!(session_marker(&format!("<!-- agent-team-session: at-pane:{id} -->")));
        assert!(!session_marker(&format!("forward at-pane:{id} to them")));
        assert!(!session_marker("at-pane:not-a-uuid"));
        assert_eq!(typed("<timestamp>x</timestamp>\n<user_query>\n  hi  \n</user_query>"), Some("hi"));
        assert_eq!(typed("<user_info>rules</user_info>"), None);
    }
}
