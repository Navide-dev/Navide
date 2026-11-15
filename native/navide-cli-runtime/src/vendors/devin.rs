//! Devin CLI (Cognition). No reader names a session Navide started.
use crate::decl::*;

pub static CLI: Cli = Cli {
    key: "devin",
    label: "Devin CLI (Cognition)",
    kind: Kind::Cli,
    order: Order { menu: 170, registry: 70 },
    // `--model` is documented but unchecked against an invalid value.
    launch: Launch { yolo_args: &["--permission-mode", "dangerous"], ..Launch::of("devin") },
    resume: Resume::NONE,
    interrupt: b"\x03",
};

crate::unobserved!(CLI);
