//! The checked-in copies of `declarations launch` are what this source
//! prints. The backend's vendor registry and the frontend's agent specs are
//! built from those copies, so a declaration changed without regenerating
//! them fails here: from source, under plain `cargo test`, with no binary.
//!
//! `NAVIDE_DECLARATIONS_WRITE=1 cargo test --test checked_in` rewrites both.
use navide_cli_runtime::registry;
use std::path::{Path, PathBuf};

/// The backend's copy: the JSON as printed.
const BACKEND: &str = "backend/agent_team_backend/cli_declarations.json";
/// The frontend's copy: the same JSON as a typed constant, so the agent keys
/// are a literal union at compile time (a `.json` import widens them to
/// `string`). `_`: infrastructure of that directory, not a spec file.
const FRONTEND: &str = "src/renderer/src/platform/plugin-shell/agents/_cli_declarations.ts";

const TS_HEADER: &str = "\
// Generated from native/navide-cli-runtime/src/vendors/*.rs: the output of
// `navide-cli-runtime declarations launch`, as a typed constant. Never edited
// by hand. `NAVIDE_DECLARATIONS_WRITE=1 cargo test --test checked_in` (in
// native/navide-cli-runtime) rewrites it together with the backend's copy.
";

fn typescript(json: &str) -> String {
    format!("{TS_HEADER}export default {} as const\n", json.trim_end())
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).expect("the crate lives in native/<name>").to_owned()
}

#[test]
fn the_checked_in_declarations_are_what_the_source_prints() {
    let json = registry::launch_json();
    let copies = [(BACKEND, json.clone()), (FRONTEND, typescript(&json))];
    let write = std::env::var("NAVIDE_DECLARATIONS_WRITE").as_deref() == Ok("1");
    for (file, expected) in copies {
        let path = repo().join(file);
        if write {
            std::fs::write(&path, &expected).unwrap_or_else(|err| panic!("{file}: {err}"));
        }
        let found = std::fs::read_to_string(&path).unwrap_or_else(|err| panic!("{file}: {err}"));
        assert!(
            found == expected,
            "{file} is stale: run `NAVIDE_DECLARATIONS_WRITE=1 cargo test --test checked_in` in native/navide-cli-runtime and commit both files"
        );
    }
}
