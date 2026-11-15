//! Kilo Code CLI: an OpenCode fork with the same store under another name,
//! `$XDG_DATA_HOME|~/.local/share` + `/kilo/kilo.db` (only the stable
//! channel's database), so its records are OpenCode's declaration.
use crate::decl::*;

pub static CLI: Cli = Cli {
    key: "kilo",
    label: "Kilo Code CLI",
    kind: Kind::Cli,
    order: Order { menu: 80, registry: 120 },
    launch: Launch { yolo_args: &["--auto"], model: Some(&["--model", "{}"]), env_strip: &["KILO_CONFIG_DIR", "KILO_CONFIG"], ..Launch::of("kilo") },
    resume: Resume {
        args: Some(&["--session", "{id}"]),
        parse: Some(ResumeParse {
            programs: &["kilo"],
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

crate::vendors::opencode::store!(CLI, "kilo.db");
