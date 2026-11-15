//! Kiro CLI (AWS). No reader names a session Navide started.
use crate::decl::*;

pub static CLI: Cli = Cli {
    key: "kiro",
    label: "Kiro CLI (AWS)",
    kind: Kind::Cli,
    order: Order { menu: 180, registry: 140 },
    // `kiro` alone opens the IDE.
    launch: Launch { base_args: &["chat", "--v3"], yolo_args: &["--trust-all-tools"], env_strip: &["KIRO_HOME"], ..Launch::of("kiro-cli") },
    resume: Resume::NONE,
    interrupt: b"\x03",
};

crate::unobserved!(CLI);
