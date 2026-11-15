//! GitHub Copilot CLI. Since 1.0.78 every session is in one SQLite store,
//! `$COPILOT_HOME|~/.copilot` + `/session-store.db`: `assistant_usage_events`
//! has a row per model call (cache already folded into input, reasoning into
//! output), and `turns` a row per finished turn with both sides of it.
//! The 1.0.75 `session-state/<id>/events.jsonl` files reconcile against that
//! store (a session the store lists is skipped), so they stay on main's
//! reader: any other file answers `Unsupported`.
use crate::decl::*;

#[derive(Debug)]
pub struct V;

slots! { Cwd = "cwd", SessionId = "session_id" }

impl Vendor for V {
    type Slot = Slot;
    type Ext = NoExt;
    type Backend = Sqlite;
    const CLI: &'static Cli = &CLI;
    const OBSERVE: Option<&'static Observe<Self>> = Some(&OBSERVE);
}

const ID: Text<V> = Text::Num(&Num::Of(&["id"]));
const TS: Text<V> = Text::Py(&["ts"]);

/// The usage rows after an id (`?1`), oldest first; `$tail` ends the query.
macro_rules! usage_rows {
    ($tail:literal) => {
        concat!(
            "SELECT a.id AS id, a.session_id AS session_id, a.model AS model, a.input_tokens AS input_tokens, ",
            "a.output_tokens AS output_tokens, a.created_at AS created_at, a.created_at AS ts, COALESCE(s.cwd, '') AS cwd, ",
            "'usage' AS source FROM assistant_usage_events a LEFT JOIN sessions s ON s.id = a.session_id ",
            "WHERE a.id > ?1 ORDER BY a.id",
            $tail
        )
    };
}

/// A table walked from its first row (the watcher has seen none of it), and
/// again from there when its ids restart: a row's key is a function of its
/// id, so a row delivered twice is dropped downstream, and one skipped is lost.
const fn table(sql: Str, newest: Str, key: Str) -> RowWalk<V> {
    RowWalk { sql, id: "id", newest, page: -1, first_sight: FirstSight::Start, shrink: Shrink::ToStart, hold_last: None, revisit: None, last_as: None, key }
}

pub static CLI: Cli = Cli {
    key: "copilot",
    label: "GitHub Copilot CLI",
    kind: Kind::Cli,
    order: Order { menu: 100, registry: 50 },
    launch: Launch {
        yolo_args: &["--yolo"],
        model: Some(&["--model", "{}"]),
        effort: Some(&["--reasoning-effort", "{}"]),
        efforts: &["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        env_strip: &["COPILOT_HOME"],
        ..Launch::of("copilot")
    },
    resume: Resume {
        // The `=` form: the flag is scoped to an id that already exists.
        args: Some(&["--resume={id}"]),
        parse: Some(ResumeParse {
            programs: &["copilot"],
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
    file_name: Some("session-store.db"),
    other_files: OtherFiles::Unsupported,
    slots: &[],
    cwd: Some(Slot::Cwd),
    session: Some(Slot::SessionId),
    cwd_form: Form::Written,
    records: SqliteRecords {
        json: &[],
        binary: &[],
        requires: &[],
        // main's reader warns (once) about a store it cannot read.
        unreadable: Unreadable::Unsupported,
        seeds: &[],
        usage: SqlUsage::Anchored(Anchored::of(
            &[UsageRule {
                when: Pred::True,
                effects: &[],
                reading: Some(Reading {
                    model: Text::Py(&["model"]),
                    timestamp: TS,
                    cwd: Text::Py(&["cwd"]),
                    session_id: Text::Py(&["session_id"]),
                    ..Reading::of(Num::Of(&["input_tokens"]), Num::Of(&["output_tokens"]), Text::Concat(&[Text::Lit("copilot_usage::"), ID]))
                }),
            }],
            usage_rows!(""),
            "id",
            "SELECT COALESCE(MAX(id), 0) FROM assistant_usage_events",
            "SELECT session_id, model, input_tokens, output_tokens, created_at FROM assistant_usage_events WHERE id = ?",
            &["session_id", "model", "input_tokens", "output_tokens", "created_at"],
        )),
        // Usage rows are the heartbeat inside a turn, and are walked first so
        // that the turn row's `turn_complete` closes the pass.
        activity: SqlWalk::Tables(&[
            table(usage_rows!(" LIMIT ?2"), "SELECT COALESCE(MAX(id), 0) FROM assistant_usage_events", "db_act_hw::usage:"),
            table(
                "SELECT t.id AS id, t.session_id AS session_id, t.user_message AS user_message, \
                 t.assistant_response AS assistant_response, t.timestamp AS ts, COALESCE(s.cwd, '') AS cwd, 'turn' AS source \
                 FROM turns t LEFT JOIN sessions s ON s.id = t.session_id WHERE t.id > ?1 ORDER BY t.id LIMIT ?2",
                "SELECT COALESCE(MAX(id), 0) FROM turns",
                "db_act_hw::turn:",
            ),
        ]),
    },
    activity: Activity::rules(&[
        // Each row names its own session and cwd.
        Rule { when: Pred::True, effects: &[Effect::Set(Slot::Cwd, Text::Py(&["cwd"])), Effect::Set(Slot::SessionId, Text::Py(&["session_id"]))] },
        Rule {
            when: Pred::Eq(&["source"], "usage"),
            effects: &Emit::active(Text::Concat(&[Text::Lit("db_act:usage:"), ID]), Text::Lit("assistant"), Text::Lit(""), TS).last(),
        },
        // A turn row appears when the turn ends and carries both sides of it.
        Rule {
            when: Pred::Eq(&["source"], "turn"),
            effects: &[
                Emit::active(Text::Concat(&[Text::Lit("db_act:turn:"), ID]), Text::Lit("user"), Text::UserPrompt(&Text::Py(&["user_message"])), TS).effect(),
                Emit::done(Text::Concat(&[Text::Lit("db_turn:"), ID]), Text::Lit("turn_row"), Text::Py(&["assistant_response"]), TS).effect(),
            ],
        },
    ]),
    turns: Turns::Inferred,
};
