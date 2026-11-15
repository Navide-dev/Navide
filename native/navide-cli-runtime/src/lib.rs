//! Navide's agent-CLI runtime, organised around a CLI's lifecycle: launch
//! (declared data the app's specs are built from), session (PTY; not wired
//! in yet), observe (records → usage, activity, turns) and resume.
//! See DESIGN.md. A CLI is one declaration under `src/vendors/`.
pub mod decl;
pub mod expr;
pub mod observe;
pub mod proto;
pub mod pyjson;
pub mod resume;
#[cfg(unix)]
pub mod session;
pub mod text;
pub mod time;
pub mod wire;

mod blake2b;
mod md5;

/// For `slots!` in a crate that does not name serde itself.
pub use serde;

// `pub mod vendors` (one module per file of `src/vendors/`) and
// `each_vendor!`, which hands their names to another macro.
include!(concat!(env!("OUT_DIR"), "/vendors.rs"));

pub mod registry;

pub fn cli(key: &str) -> Option<&'static decl::Cli> {
    registry::ALL.iter().copied().find(|c| c.key == key)
}
