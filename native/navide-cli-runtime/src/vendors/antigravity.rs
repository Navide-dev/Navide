//! Antigravity CLI (`agy`). One SQLite database per conversation,
//! `~/.gemini/antigravity-cli/conversations/<id>.db`. Its payloads are
//! undocumented protobuf, so token counts are not read (no usage, no turns).
//! The `steps` table keeps `idx`, `step_type` and `status` as integers: each
//! new step is one activity event, and only the turn's text is decoded out of
//! a protobuf blob. An assistant step still streaming is read again until it
//! finishes; a finished reply ends the turn only as the pass's newest step.
use crate::decl::*;
use crate::expr::{py_str_opt, Scope};
use crate::proto;
use crate::text::{posix_normalise, unquote};
use crate::time;
use serde::Serialize;

#[derive(Debug)]
pub struct V;

slots! { SessionId = "session_id", Cwd = "cwd" }

/// What only Antigravity's store needs: its text is inside protobuf blobs.
#[derive(Debug, Clone, Copy, Serialize)]
pub enum Ext {
    /// Text, for the walk's `Cwd` seed: the workspace is a `file://` URI that
    /// the metadata blob repeats, some copies followed by protobuf bytes that
    /// read as printable junk. main picks among the candidates by whether the
    /// path is a directory on disk, then by how often it occurs, then the
    /// shortest: a file-system heuristic no record can carry, so this one
    /// text function looks at the disk. Read once per walk, on the walk's
    /// connection (`StoreSeed`).
    Workspace,
    /// Text: the user's prompt (payload field 19, text field 2).
    Prompt,
    /// Text: the assistant's reply (payload field 20, text fields 1 or 8).
    Reply,
    /// Text: its thinking (payload field 20, text field 3).
    Thinking,
    /// Text: the step's end time, else its start: the first of the metadata's
    /// `google.protobuf.Timestamp` fields 8, 7, 6 with non-zero seconds.
    Stamp,
}

impl Vendor for V {
    type Slot = Slot;
    type Ext = Ext;
    type Backend = Sqlite;
    const CLI: &'static Cli = &CLI;
    const OBSERVE: Option<&'static Observe<Self>> = Some(&OBSERVE);

    fn text(ext: Ext, scope: &Scope<'_, Self>) -> String {
        let payload = |path: &[u64], fields: &[u64]| proto::clean_text(proto::at(scope.blob("payload"), path), fields).to_owned();
        match ext {
            Ext::Prompt => payload(&[19], &[2]),
            Ext::Reply => payload(&[20], &[1, 8]),
            Ext::Thinking => payload(&[20], &[3]),
            Ext::Stamp => {
                let metadata = scope.blob("metadata");
                [8, 7, 6]
                    .iter()
                    .map(|field| proto::bytes(metadata, *field))
                    .filter(|stamp| !stamp.is_empty())
                    .find_map(|stamp| proto::varint_field(stamp, 1).filter(|seconds| *seconds != 0))
                    .and_then(|seconds| i64::try_from(seconds).ok()?.checked_mul(1_000_000))
                    .map(time::iso_from_micros)
                    .unwrap_or_default()
            }
            Ext::Workspace => workspace(&py_str_opt(scope.get(&["text"]))),
        }
    }
}

fn workspace(text: &str) -> String {
    let mut counts: Vec<(String, usize)> = Vec::new();
    let mut from = 0;
    while let Some(found) = text[from..].find("file://") {
        let start = from + found + "file://".len();
        let tail = &text[start..];
        let run = &tail[..tail.find(|c: char| c < ' ' || c == '\x7f').unwrap_or(tail.len())];
        let mut chars = run.chars();
        let rooted = run.starts_with('/') && run.chars().count() > 1;
        let drive = matches!((chars.next(), chars.next(), chars.next(), chars.next()),
            (Some(l), Some(':'), Some('\\' | '/'), Some(_)) if l.is_ascii_alphabetic());
        if !(rooted || drive) {
            from = from + found + 1;
            continue;
        }
        from = start + run.len();
        let path = unquote(strip_drive_slashes(run));
        let path = path.trim_end_matches('/');
        if !path.is_empty() {
            let key = posix_normalise(path);
            match counts.iter_mut().find(|(p, _)| *p == key) {
                Some((_, n)) => *n += 1,
                None => counts.push((key, 1)),
            }
        }
    }
    // `sorted(key=(not is_dir, -count, len))`: stable, so first seen wins ties.
    counts.sort_by_key(|(p, n)| (!std::path::Path::new(p).is_dir(), std::cmp::Reverse(*n), p.chars().count()));
    counts.into_iter().next().map(|(p, _)| p).unwrap_or_default()
}

/// `^/+(?=[A-Za-z]:)`: a `file:///C:/…` URI's slash before the drive.
fn strip_drive_slashes(run: &str) -> &str {
    let rest = run.trim_start_matches('/');
    let mut chars = rest.chars();
    match (chars.next(), chars.next()) {
        (Some(l), Some(':')) if l.is_ascii_alphabetic() => rest,
        _ => run,
    }
}

const STEP: Text<V> = Text::Num(&Num::Of(&["step_type"]));
const DONE: Pred<V> = Pred::Text(Text::Num(&Num::Of(&["status"])), StrTest::Eq("3"));
const ASSISTANT: Pred<V> = Pred::Text(STEP, StrTest::Eq("15"));
const REPLY: Text<V> = Text::Ext(Ext::Reply);
const KEY: Text<V> = Text::Concat(&[Text::Lit("step:"), Text::Slot(Slot::SessionId), Text::Lit(":"), Text::Num(&Num::Of(&["idx"]))]);
const TS: Text<V> = Text::Ext(Ext::Stamp);

pub static CLI: Cli = Cli {
    key: "antigravity",
    label: "Antigravity CLI (Google)",
    kind: Kind::Cli,
    order: Order { menu: 30, registry: 20 },
    launch: Launch {
        yolo_args: &["--dangerously-skip-permissions"],
        model: Some(&["--model", "{}"]),
        effort: Some(&["--effort", "{}"]),
        efforts: &["low", "medium", "high"],
        ..Launch::of("agy")
    },
    resume: Resume {
        args: Some(&["--conversation", "{id}"]),
        parse: Some(ResumeParse {
            programs: &["agy"],
            tokens: Tokens::Literal,
            subcommand: &[],
            id_after_subcommand: false,
            flags: &["--conversation"],
            joined: Some(ValueShape::NoDash),
            pick: Pick::First,
            value: ValueShape::NoDash,
        }),
    },
    interrupt: b"\x03",
};

static OBSERVE: Observe<V> = Observe {
    file_name: None,
    other_files: OtherFiles::Empty,
    slots: &[Seed { slot: Slot::SessionId, init: SlotInit::FileStem }],
    cwd: Some(Slot::Cwd),
    session: Some(Slot::SessionId),
    cwd_form: Form::Written,
    records: SqliteRecords {
        json: &[],
        binary: &["metadata", "payload"],
        requires: &[],
        unreadable: Unreadable::Quiet,
        // Only a walk needs the workspace (usage reads nothing).
        seeds: &[StoreSeed { slot: Slot::Cwd, sql: "SELECT data FROM trajectory_metadata_blob", value: Text::Ext(Ext::Workspace) }],
        // main's base reader: no token records, its legacy checkpoint kept.
        usage: SqlUsage::Legacy,
        activity: SqlWalk::Rows(RowWalk {
            sql: "SELECT idx, step_type, status, metadata, step_payload AS payload FROM steps \
                  WHERE idx > ?1 OR idx IN (SELECT value FROM json_each(?3)) ORDER BY idx LIMIT ?2",
            id: "idx",
            newest: "SELECT MAX(idx) FROM steps",
            page: 256,
            first_sight: FirstSight::Newest,
            shrink: Shrink::Ignore,
            hold_last: None,
            revisit: Some(Revisit { when: Pred::All(&[ASSISTANT, Pred::Not(&DONE)]), key: "agy_pending::" }),
            last_as: Some("last"),
            key: "agy_idx::",
        }),
    },
    activity: Activity {
        ..Activity::rules(&[
            Rule {
                when: Pred::Text(STEP, StrTest::Eq("14")),
                effects: &Emit::active(KEY, Text::Lit("user"), Text::UserPrompt(&Text::Ext(Ext::Prompt)), TS).last(),
            },
            // ask_question: the agent waits on the user, so the turn is over.
            Rule { when: Pred::Text(STEP, StrTest::Eq("138")), effects: &Emit::done(KEY, Text::Lit("assistant:question"), Text::Lit(""), TS).last() },
            // A finished reply with no later step in this pass: the closest thing to an end of turn.
            Rule {
                when: Pred::All(&[ASSISTANT, Pred::Text(REPLY, StrTest::NonEmpty), DONE, Pred::Truthy(&["last"])]),
                effects: &Emit::done(KEY, Text::Lit("assistant"), REPLY, TS).last(),
            },
            Rule {
                when: ASSISTANT,
                effects: &Emit::active(
                    KEY,
                    Text::FirstOf(&[Text::If(&Pred::Text(Text::Ext(Ext::Thinking), StrTest::NonEmpty), &Text::Lit("assistant:thinking")), Text::Lit("assistant")]),
                    Text::Lit(""),
                    TS,
                )
                .last(),
            },
            Rule { when: Pred::True, effects: &Emit::active(KEY, Text::Concat(&[Text::Lit("step-"), STEP]), Text::Lit(""), TS).last() },
        ])
    },
    // Token counts live in undocumented protobuf: none read, no turns to cut.
    turns: Turns::None,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_prefers_a_directory_then_frequency_then_length() {
        // A clean copy and two junk-suffixed ones; only the clean one is a directory.
        let text = "\u{12}0file:///usr\u{0}\"A$9bc-uuid:/file:///usrz\u{88}\u{1}file:///usrz\u{88}";
        assert_eq!(workspace(text), "/usr");
        assert_eq!(workspace("file:///no/such%20dir/\u{0}"), "/no/such dir");
        assert_eq!(workspace("file:///C:/work\u{0}"), "C:/work");
        assert_eq!(workspace("file:// nothing"), "");
    }
}
