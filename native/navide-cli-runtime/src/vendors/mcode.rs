//! MiniMax Code. Strict about unknown flags; no session Navide can name.
use crate::decl::*;

pub static CLI: Cli = Cli {
    key: "mcode",
    label: "MiniMax Code",
    kind: Kind::Cli,
    order: Order { menu: 150, registry: 150 },
    // Unattended mode is the `permissionMode` setting, not a flag.
    launch: Launch { env_strip: &["MINIMAX_DATA_DIR", "MAVIS_DATA_DIR"], ..Launch::of("mcode") },
    resume: Resume::NONE,
    interrupt: b"\x03",
};

crate::unobserved!(CLI);
