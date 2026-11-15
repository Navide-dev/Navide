//! OpenClaw. One SQLite store per agent,
//! `$OPENCLAW_STATE_DIR|~/.openclaw` + `agents/*/agent/openclaw-agent.sqlite`,
//! whose `transcript_events` holds every session's events under a per-session
//! `seq`. The store records no cwd. Tokens come from assistant messages that
//! carry `usage`; activity is one event per message row, and an assistant
//! message with a final `stopReason` ends the turn. Rows are read per session
//! (`Partition`), and each session's events carry its Navide session key.
use crate::decl::*;
use crate::expr::{py_float, Scope};
use crate::time;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug)]
pub struct V;

/// What only OpenClaw's store needs.
#[derive(Debug, Clone, Copy, Serialize)]
pub enum Ext {
    /// Text: the event's `timestamp`, else its message's: an ISO string as
    /// is, or a number as epoch seconds (milliseconds above 1e11).
    Stamp,
    /// Numbers: main's `_num` of the message's `usage` counters, which may be
    /// strings or floats. No `input` or no `output` is no reading at all; a
    /// missing cache counter is 0.
    Input,
    Output,
    CacheRead,
    CacheWrite,
}

fn counter(scope: &Scope<'_, V>, key: &str) -> Option<i64> {
    py_float(scope.get(&["event", "message", "usage", key])).filter(|f| f.is_finite()).map(|f| f.trunc() as i64)
}

impl Vendor for V {
    type Slot = NoSlot;
    type Ext = Ext;
    type Backend = Sqlite;
    const CLI: &'static Cli = &CLI;
    const OBSERVE: Option<&'static Observe<Self>> = Some(&OBSERVE);

    fn text(ext: Ext, scope: &Scope<'_, Self>) -> String {
        if !matches!(ext, Ext::Stamp) {
            return String::new();
        }
        for path in [&["event", "timestamp"][..], &["event", "message", "timestamp"][..]] {
            match scope.get(path) {
                Some(Value::String(stamp)) if !stamp.is_empty() => return stamp.clone(),
                value => match py_float(value) {
                    Some(n) if n != 0.0 => return time::iso_from_float(if n > 1e11 { n / 1000.0 } else { n }),
                    _ => {}
                },
            }
        }
        String::new()
    }

    fn num(ext: Ext, scope: &Scope<'_, Self>) -> Option<i64> {
        let cache = |key| counter(scope, key).unwrap_or(0);
        match ext {
            Ext::Input => Some(counter(scope, "input")?.saturating_add(cache("cacheRead")).saturating_add(cache("cacheWrite"))),
            Ext::Output => counter(scope, "output"),
            Ext::CacheRead => Some(cache("cacheRead")),
            Ext::CacheWrite => Some(cache("cacheWrite")),
            Ext::Stamp => None,
        }
    }
}

/// The value at the path, only when it is a session key Navide handed out.
macro_rules! keyed {
    ($($p:literal),+) => {
        Text::If(&Pred::Text(Text::Str(&[$($p),+]), StrTest::StartsWith("agent:")), &Text::Str(&[$($p),+]))
    };
}

/// A readable `message` event (main's `_message`).
const MESSAGE_ROW: Pred<V> = Pred::All(&[Pred::Eq(&["event", "type"], "message"), Pred::IsObject(&["event", "message"])]);
/// The message's role, else the row's `message_role`.
const ROLE: Text<V> = Text::FirstOf(&[Text::Py(&["event", "message", "role"]), Text::Py(&["role"])]);
const ASSISTANT: Pred<V> = Pred::Eq(&["event", "message", "role"], "assistant");
const CONTENT: Text<V> = Text::Blocks(&["event", "message", "content"], "text");
const STOP: Path = &["event", "message", "stopReason"];
const TS: Text<V> = Text::Ext(Ext::Stamp);
const KEY: Text<V> = Text::Py(&["key"]);
const SEQ_KEY: Text<V> = Text::Concat(&[Text::Lit("seq:"), Text::Py(&["sid"]), Text::Lit(":"), Text::Py(&["seq"])]);

const fn event(emit: Emit<V>) -> [Effect<V>; 2] {
    emit.of_session(KEY).last()
}

/// One page of a session's rows after its watermark; a trailing assistant
/// message without its stopReason yet is read again next pass.
const PAGE: Page<V> = Page {
    sql: "SELECT seq, session_id AS sid, message_role AS role, event_json AS event FROM transcript_events \
          WHERE session_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3",
    id: "seq",
    size: 512,
    hold_last: Some(Pred::All(&[MESSAGE_ROW, ASSISTANT, Pred::Not(&Pred::Truthy(STOP))])),
};
/// A session's key: the id itself when it is one, else what the session
/// tables map it to (absent in some builds), else the session header's.
const SESSIONS: Partition<V> = Partition {
    tops: "SELECT session_id AS part, MAX(seq) AS top FROM transcript_events GROUP BY session_id",
    label: &[
        ("SELECT ?1 AS label", keyed!("label")),
        ("SELECT session_key AS label FROM session_windows WHERE session_id = ?1 LIMIT 1", keyed!("label")),
        ("SELECT session_key AS label FROM session_nodes WHERE current_session_id = ?1 LIMIT 1", keyed!("label")),
        (
            "SELECT event_json AS header FROM transcript_events WHERE session_id = ?1 ORDER BY seq LIMIT 1",
            Text::If(&Pred::Eq(&["header", "type"], "session"), &Text::FirstOf(&[keyed!("header", "sessionKey"), keyed!("header", "key")])),
        ),
    ],
    label_as: "key",
    // main's own warning, word for word.
    unlabelled: "openclaw store {path}: session {part} names no session key in transcript_events, session_windows or session_nodes — its turns reach no pane",
};

pub static CLI: Cli = Cli {
    key: "openclaw",
    label: "OpenClaw",
    kind: Kind::Agent,
    order: Order { menu: 190, registry: 180 },
    // The TUI on the local embedded runtime (a bare `openclaw` attaches to a gateway).
    launch: Launch { base_args: &["tui", "--local"], ..Launch::of("openclaw") },
    resume: Resume {
        args: Some(&["--session", "{id}"]),
        parse: Some(ResumeParse {
            programs: &["openclaw"],
            tokens: Tokens::Literal,
            subcommand: &[],
            id_after_subcommand: false,
            flags: &["--session"],
            joined: Some(ValueShape::Prefix("agent:")),
            pick: Pick::First,
            value: ValueShape::Prefix("agent:"),
        }),
    },
    interrupt: b"\x03",
};

static OBSERVE: Observe<V> = Observe {
    file_name: Some("openclaw-agent.sqlite"),
    other_files: OtherFiles::Empty,
    slots: &[],
    // The store records no cwd, and every row names its own session.
    cwd: None,
    session: None,
    cwd_form: Form::Written,
    records: SqliteRecords {
        json: &["event", "header"],
        binary: &[],
        requires: &[("transcript_events", &["session_id", "seq", "event_json", "message_role"])],
        unreadable: Unreadable::Quiet,
        seeds: &[],
        usage: SqlUsage::Watermarks {
            rules: &[UsageRule {
                when: Pred::All(&[MESSAGE_ROW, ASSISTANT, Pred::IsObject(&["event", "message", "usage"])]),
                effects: &[],
                reading: Some(Reading {
                    cache_read: Num::Ext(Ext::CacheRead),
                    cache_creation: Num::Ext(Ext::CacheWrite),
                    model: Text::Py(&["event", "message", "model"]),
                    timestamp: TS,
                    session_id: KEY,
                    ..Reading::of(
                        Num::Ext(Ext::Input),
                        Num::Ext(Ext::Output),
                        Text::Concat(&[Text::Lit("openclaw:"), Text::Py(&["sid"]), Text::Lit(":"), Text::Py(&["seq"])]),
                    )
                }),
            }],
            page: PAGE,
            part: SESSIONS,
            kind: "openclaw_seq",
            map: "sessions",
        },
        // A session whose newest seq fell below its mark was rewritten: re-anchor there.
        activity: SqlWalk::Partitions { page: PAGE, part: SESSIONS, restart_below: true, key: "openclaw_seq::", anchor: "openclaw_anchor::" },
    },
    activity: Activity::rules(&[
        Rule { when: Pred::Not(&MESSAGE_ROW), effects: &[Effect::Stop] },
        Rule {
            when: Pred::Text(ROLE, StrTest::Eq("user")),
            effects: &event(Emit::active(SEQ_KEY, Text::Lit("user"), Text::UserPrompt(&CONTENT), TS).with_text()),
        },
        Rule {
            when: Pred::All(&[Pred::Text(ROLE, StrTest::Eq("assistant")), Pred::Truthy(STOP), Pred::Not(&Pred::Eq(STOP, "toolUse"))]),
            effects: &event(Emit::done(SEQ_KEY, Text::Py(STOP), Text::Cap(&CONTENT, 8000), TS)),
        },
        Rule { when: Pred::Text(ROLE, StrTest::Eq("assistant")), effects: &event(Emit::active(SEQ_KEY, Text::Lit("assistant"), Text::Lit(""), TS)) },
        Rule { when: Pred::Text(ROLE, StrTest::In(&["toolResult", "tool"])), effects: &event(Emit::active(SEQ_KEY, Text::Lit("tool"), Text::Lit(""), TS)) },
    ]),
    // The generic cut re-reads activity from first sight, which anchors
    // every session (no replay): there would be no boundaries at all.
    turns: Turns::None,
};
