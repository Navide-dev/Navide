//! A CLI the crate has never heard of, declared only here, runs the whole
//! lifecycle: its launch data exported, resume parsing, usage with a
//! checkpoint, activity with a resumed walk, and inferred turns. Nothing in `src/`
//! changes for it — that is the extension contract. It also has a value no
//! shared construct reads (its token counts are a list of parts), which it
//! extracts with its own `Ext` function instead of a new core variant.
use navide_cli_runtime::decl::*;
use navide_cli_runtime::expr::Scope;
use navide_cli_runtime::observe::{ActivityState, Observer};
use navide_cli_runtime::resume::{self, Command};
use serde::Serialize;
use serde_json::{Map, Value};
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug)]
struct Toy;

slots! { Cwd = "cwd", SessionId = "session_id", Reply = "reply" }

#[derive(Debug, Clone, Copy, Serialize)]
enum Ext {
    /// Number: the sum of `usage.in`, which this CLI writes as a list of parts.
    InputParts,
}

impl Vendor for Toy {
    type Slot = Slot;
    type Ext = Ext;
    type Backend = Jsonl;
    const CLI: &'static Cli = &TOY;
    const OBSERVE: Option<&'static Observe<Self>> = Some(&OBSERVE);

    fn num(ext: Ext, scope: &Scope<'_, Self>) -> Option<i64> {
        match ext {
            Ext::InputParts => Some(scope.get(&["usage", "in"])?.as_array()?.iter().filter_map(Value::as_i64).sum()),
        }
    }
}

const TS: Text<Toy> = Text::Py(&["ts"]);
const LINE_KEY: Text<Toy> = Text::Concat(&[Text::Lit("act:"), Text::Line]);

static TOY: Cli = Cli {
    key: "toy",
    label: "Toy CLI",
    kind: Kind::Cli,
    order: Order { menu: 9000, registry: 9000 },
    launch: Launch {
        base_args: &["chat"],
        yolo_args: &["--yes"],
        model: Some(&["-m", "{}"]),
        effort: Some(&["--think={}"]),
        efforts: &["low", "high"],
        env_defaults: &[("TOY_COLOR", "never")],
        env_strip: &["TOY_HOME"],
        ..Launch::of("toy")
    },
    resume: Resume {
        args: Some(&["--continue", "{id}"]),
        parse: Some(ResumeParse {
            programs: &["toy"],
            tokens: Tokens::Whitespace,
            subcommand: &[],
            id_after_subcommand: false,
            flags: &["--continue", "-c"],
            joined: None,
            pick: Pick::Last,
            value: ValueShape::NoDash,
        }),
    },
    interrupt: b"\x03",
};

static OBSERVE: Observe<Toy> = Observe {
    file_name: None,
    other_files: OtherFiles::Empty,
    slots: &[
        Seed { slot: Slot::Cwd, init: SlotInit::Header { lines: 1, when: Pred::Eq(&["type"], "meta"), field: Text::Py(&["cwd"]), first_line: true } },
        Seed { slot: Slot::SessionId, init: SlotInit::FileStem },
    ],
    cwd: Some(Slot::Cwd),
    session: Some(Slot::SessionId),
    cwd_form: Form::Written,
    records: JsonlRecords {
        usage: Some(FileUsage::per_record(
            &[UsageRule {
                when: Pred::All(&[Pred::Eq(&["type"], "reply"), Pred::IsObject(&["usage"])]),
                effects: &[],
                reading: Some(Reading {
                    cache_read: Num::Of(&["usage", "cached"]),
                    key_required: true,
                    model: Text::Py(&["model"]),
                    timestamp: TS,
                    cwd: Text::Slot(Slot::Cwd),
                    session_id: Text::Slot(Slot::SessionId),
                    ..Reading::of(Num::Sum(&[Num::Ext(Ext::InputParts), Num::Of(&["usage", "cached"])]), Num::Of(&["usage", "out"]), Text::Py(&["id"]))
                }),
            }],
            8,
        )),
        cursor: LineCursor::Lines,
    },
    activity: Activity {
        turn_text: Some(Slot::Reply),
        kept: &[Kept { slot: Slot::Reply, prefix: "toy_text::", form: KeptForm::Text }],
        turn_key: Some(TurnKey { prefix: "toy_turn::", compact: true, keep_null: false }),
        ..Activity::rules(&[
            Rule {
                when: Pred::Eq(&["type"], "user"),
                effects: &[
                    Effect::Turn(TurnOp::Open { boundary: "boundary", ts: TS, ms: Num::Zero }),
                    Emit::active(LINE_KEY, Text::Lit("user"), Text::UserPrompt(&Text::Str(&["text"])), TS).effect(),
                ],
            },
            Rule {
                when: Pred::Eq(&["type"], "reply"),
                effects: &[
                    Effect::Turn(TurnOp::EnsureOpen { ts: TS, ms: Num::Zero }),
                    Effect::Turn(TurnOp::Touch { ts: Some(TS), ms: None }),
                    Effect::SetIfNonEmpty(Slot::Reply, Text::Strip(&Text::Str(&["text"]))),
                    Emit::active(LINE_KEY, Text::Lit("assistant"), Text::Lit(""), TS).effect(),
                ],
            },
            Rule { when: Pred::Eq(&["type"], "done"), effects: &[Effect::Turn(TurnOp::Close { detail: "end_turn", ms: None })] },
        ])
    },
    turns: Turns::Inferred,
};

struct Dir(PathBuf);

impl Dir {
    fn new(tag: &str) -> Self {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("navide-cli-runtime-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        Dir(dir)
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn append(path: &std::path::Path, lines: &[&str]) {
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
    for line in lines {
        writeln!(file, "{line}").unwrap();
    }
}

#[test]
fn launch_and_resume_come_from_the_declaration() {
    // What the app's specs are built from (`declarations launch`): the
    // declaration as data, whole.
    let exported = serde_json::to_value(&TOY).unwrap();
    assert_eq!(exported["launch"]["program"], "toy");
    assert_eq!(exported["launch"]["model"], serde_json::json!(["-m", "{}"]));
    assert_eq!(exported["launch"]["env_strip"], serde_json::json!(["TOY_HOME"]));
    assert_eq!(exported["resume"]["args"], serde_json::json!(["--continue", "{id}"]));

    assert_eq!(resume::id_from_command(&TOY, &Command::Text("toy chat -c old --continue new")), "new");
    assert_eq!(resume::id_from_command(&TOY, &Command::Text("toy chat --continue -x")), "");
    assert_eq!(resume::id_from_command(&TOY, &Command::Text("other --continue s")), "");
}

#[test]
fn observe_runs_end_to_end() {
    let dir = Dir::new("toy");
    let path = dir.0.join("sess-1.jsonl");
    append(
        &path,
        &[
            r#"{"type":"meta","cwd":"/work/toy"}"#,
            r#"{"type":"user","text":"  fix the build  ","ts":"2026-01-01T00:00:01Z"}"#,
            r#"{"type":"reply","id":"r1","model":"toy-1","text":" working ","ts":"2026-01-01T00:00:02Z","usage":{"in":[7,3],"cached":5,"out":3}}"#,
        ],
    );
    let mut observer = Observer::<Toy>::new().expect("toy declares observe");

    let first = observer.usage(&path, &Map::new()).unwrap();
    assert_eq!(first.events.len(), 1);
    let call = &first.events[0];
    assert_eq!((call.input_tokens, call.output_tokens, call.cache_read_tokens), (15, 3, 5));
    assert_eq!((call.cwd.as_str(), call.session_id.as_str(), call.model.as_str()), ("/work/toy", "sess-1", "toy-1"));

    let mut state = ActivityState::default();
    let events = observer.activity(&path, &mut state).unwrap();
    let details: Vec<&str> = events.iter().map(|e| e.detail.as_str()).collect();
    assert_eq!(details, ["user", "assistant"]);
    assert_eq!(events[0].text, "fix the build");
    assert_eq!(state.hw, 3);

    // A second reply and the end of the turn: only the new records count.
    append(
        &path,
        &[
            r#"{"type":"reply","id":"r2","model":"toy-1","text":"done it","ts":"2026-01-01T00:00:04Z","usage":{"in":[4],"cached":0,"out":2}}"#,
            r#"{"type":"done","ts":"2026-01-01T00:00:05Z"}"#,
        ],
    );
    let second = observer.usage(&path, &first.checkpoint).unwrap();
    assert_eq!(second.events.iter().map(|e| e.dedup_key.as_str()).collect::<Vec<_>>(), ["r2"]);
    let events = observer.activity(&path, &mut state).unwrap();
    let kinds: Vec<(&str, &str)> = events.iter().map(|e| (e.event_type.as_str(), e.detail.as_str())).collect();
    assert_eq!(kinds, [("agent_active", "assistant"), ("turn_complete", "end_turn")]);
    assert_eq!(events[1].text, "done it");
    assert_eq!(events[1].timestamp, "2026-01-01T00:00:04Z");

    let turns = observer.turns(&path, "sess-1").unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].prompt_excerpt, "fix the build");
    assert_eq!((turns[0].input, turns[0].output, turns[0].calls.len()), (19, 5, 2));

    // A record whose `usage.in` is not a list carries no reading at all.
    append(&path, &[r#"{"type":"reply","id":"r3","model":"toy-1","text":"x","ts":"2026-01-01T00:00:06Z","usage":{"in":9,"out":1}}"#]);
    assert!(observer.usage(&path, &second.checkpoint).unwrap().events.is_empty());
}
