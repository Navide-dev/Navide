//! SQLite access: a read-only connection opened the way main's readers open
//! one (`sqlite3.connect("file:…?mode=ro")`, a 250 ms busy wait), kept for
//! one observer call. A row is read into a JSON object keyed by column name,
//! so the declaration's predicates and texts read rows exactly as they read
//! JSONL records; binary columns stay bytes beside it. Any failure (busy,
//! locked, missing, a schema the query does not fit) is "no rows this
//! cycle", as main treats it.
//!
//! The FFI connection is the evaluation crate's: macOS links the system
//! SQLite, Linux the bundled one `libsqlite3-sys` builds, Windows the OS's
//! `winsqlite3.dll`.
use super::Error;
use crate::expr::Blob;
use crate::pyjson::{self, Parsed};
use crate::text::ignore_invalid;
use serde_json::{Map, Value};
use std::cell::Cell;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::Path;

#[cfg(target_os = "linux")]
use libsqlite3_sys as _;

#[cfg_attr(target_os = "macos", link(name = "sqlite3"))]
#[cfg_attr(windows, link(name = "winsqlite3", kind = "raw-dylib"))]
unsafe extern "C" {
    fn sqlite3_open_v2(name: *const c_char, db: *mut *mut c_void, flags: c_int, vfs: *const c_char) -> c_int;
    fn sqlite3_close(db: *mut c_void) -> c_int;
    fn sqlite3_busy_timeout(db: *mut c_void, milliseconds: c_int) -> c_int;
    fn sqlite3_prepare_v2(db: *mut c_void, sql: *const c_char, bytes: c_int, statement: *mut *mut c_void, tail: *mut *const c_char) -> c_int;
    fn sqlite3_bind_int64(statement: *mut c_void, index: c_int, value: i64) -> c_int;
    fn sqlite3_bind_text(statement: *mut c_void, index: c_int, text: *const c_char, bytes: c_int, destructor: *const c_void) -> c_int;
    fn sqlite3_step(statement: *mut c_void) -> c_int;
    fn sqlite3_column_count(statement: *mut c_void) -> c_int;
    fn sqlite3_column_name(statement: *mut c_void, column: c_int) -> *const c_char;
    fn sqlite3_column_type(statement: *mut c_void, column: c_int) -> c_int;
    fn sqlite3_column_int64(statement: *mut c_void, column: c_int) -> i64;
    fn sqlite3_column_double(statement: *mut c_void, column: c_int) -> f64;
    fn sqlite3_column_text(statement: *mut c_void, column: c_int) -> *const u8;
    fn sqlite3_column_bytes(statement: *mut c_void, column: c_int) -> c_int;
    fn sqlite3_finalize(statement: *mut c_void) -> c_int;
}

const OPEN_READONLY: c_int = 1;
const OPEN_URI: c_int = 0x40;
const ROW: c_int = 100;
const DONE: c_int = 101;

/// main's `_BUSY_TIMEOUT_MS`.
const BUSY_TIMEOUT_MS: c_int = 250;

/// Is `path` a WAL-mode database (header bytes 18 and 19 are 2)?
fn wal_header(path: &Path) -> bool {
    use std::io::Read;
    let mut header = [0u8; 20];
    std::fs::File::open(path).and_then(|mut file| file.read_exact(&mut header)).is_ok()
        && header.starts_with(b"SQLite format 3\0")
        && header[18] == 2
        && header[19] == 2
}

/// The URI SQLite opens: the path percent-encoded byte by byte (a `?`, `#`
/// or `%` in a directory name is part of the path), then the read-only mode.
fn uri(path: &Path, immutable: bool) -> Option<String> {
    let mut out = String::from("file:");
    for byte in path.to_str()?.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => out.push(byte as char),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out.push_str(if immutable { "?mode=ro&immutable=1" } else { "?mode=ro" });
    Some(out)
}

struct Connection(*mut c_void);

impl Drop for Connection {
    fn drop(&mut self) {
        unsafe { sqlite3_close(self.0) };
    }
}

struct Statement(*mut c_void);

impl Drop for Statement {
    fn drop(&mut self) {
        unsafe { sqlite3_finalize(self.0) };
    }
}

/// `path` with `suffix` appended to its file name (`-wal`, `-shm`).
fn beside(path: &Path, suffix: &str) -> std::path::PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    name.into()
}

impl Connection {
    /// Opens the way main's readers do (`mode=ro`); the second field is true
    /// when it had to be `immutable=1` instead, which reads the database file
    /// as it is and ignores any `-wal`.
    fn open(path: &Path) -> Option<(Self, bool)> {
        if !path.is_file() {
            return None;
        }
        if let Some(db) = Self::open_uri(&uri(path, false)?).filter(Connection::readable) {
            return Some((db, false));
        }
        // A WAL database whose last writer closed has no -wal/-shm, and the
        // system SQLite refuses to read it with `mode=ro` (it may not create
        // the -shm) where Python's bundled one reads it. With neither file
        // there the database file holds every committed row: `immutable=1`
        // reads it without creating anything beside it. Only that case: a
        // refusal for any other reason (busy, corrupt, not a database) stays
        // a refusal, as on main. If a writer shows up during the read the
        // caller notices (`Db::wal_appeared`) and hands the call over.
        let sidecars = ["-wal", "-shm"].iter().any(|suffix| beside(path, suffix).exists());
        if sidecars || !wal_header(path) {
            return None;
        }
        Self::open_uri(&uri(path, true)?).filter(Connection::readable).map(|db| (db, true))
    }

    fn open_uri(uri: &str) -> Option<Self> {
        let name = CString::new(uri).ok()?;
        let mut raw = std::ptr::null_mut();
        let code = unsafe { sqlite3_open_v2(name.as_ptr(), &mut raw, OPEN_READONLY | OPEN_URI, std::ptr::null()) };
        let db = (!raw.is_null()).then_some(Connection(raw));
        if code != 0 {
            return None;
        }
        let db = db?;
        (unsafe { sqlite3_busy_timeout(db.0, BUSY_TIMEOUT_MS) } == 0).then_some(db)
    }

    /// Whether the schema can be read: SQLite opens a database lazily, and a
    /// `mode=ro` open it cannot serve fails here, at the first read.
    fn readable(&self) -> bool {
        self.prepare("SELECT count(*) FROM sqlite_master", &[])
            .is_some_and(|statement| matches!(unsafe { sqlite3_step(statement.0) }, ROW | DONE))
    }

    fn prepare(&self, sql: &str, params: &[Param]) -> Option<Statement> {
        let sql = CString::new(sql).ok()?;
        let mut raw = std::ptr::null_mut();
        let code = unsafe { sqlite3_prepare_v2(self.0, sql.as_ptr(), -1, &mut raw, std::ptr::null_mut()) };
        let statement = (!raw.is_null()).then_some(Statement(raw));
        if code != 0 {
            return None;
        }
        let statement = statement?;
        for (index, value) in params.iter().enumerate() {
            let index = index as c_int + 1;
            let code = match value {
                Param::Int(n) => unsafe { sqlite3_bind_int64(statement.0, index, *n) },
                // SQLITE_STATIC (null): the text outlives the statement, which the caller finalises.
                Param::Text(t) => unsafe { sqlite3_bind_text(statement.0, index, t.as_ptr().cast(), c_int::try_from(t.len()).ok()?, std::ptr::null()) },
            };
            if code != 0 {
                return None;
            }
        }
        Some(statement)
    }

    /// `unparsed` is set when a JSON column holds text this parser rejects
    /// and Python may read (`Db::unparsed`).
    fn query(&self, sql: &str, params: &[Param], json: &[&str], binary: &[&str], unparsed: &Cell<bool>) -> Option<Vec<Row>> {
        let statement = self.prepare(sql, params)?;
        let columns: Vec<String> = (0..unsafe { sqlite3_column_count(statement.0) })
            .map(|c| {
                let name = unsafe { sqlite3_column_name(statement.0, c) };
                if name.is_null() { String::new() } else { unsafe { CStr::from_ptr(name) }.to_string_lossy().into_owned() }
            })
            .collect();
        let mut rows = Vec::new();
        loop {
            match unsafe { sqlite3_step(statement.0) } {
                DONE => break,
                ROW => {}
                _ => return None,
            }
            let mut row = Map::new();
            let mut blobs = Vec::new();
            for (c, name) in columns.iter().enumerate() {
                let c = c as c_int;
                let value = match unsafe { sqlite3_column_type(statement.0, c) } {
                    1 => Value::from(unsafe { sqlite3_column_int64(statement.0, c) }),
                    2 => serde_json::Number::from_f64(unsafe { sqlite3_column_double(statement.0, c) }).map_or(Value::Null, Value::Number),
                    kind @ (3 | 4) => {
                        let bytes = unsafe { cell(statement.0, c) };
                        let text = std::str::from_utf8(bytes);
                        let blob = kind == 4;
                        if binary.contains(&name.as_str()) {
                            // Only a BLOB is binary (main's `x if isinstance(x, bytes) else b""`).
                            if blob {
                                blobs.push((name.clone(), bytes.to_vec()));
                            }
                            Value::Null
                        } else {
                            match (blob, json.contains(&name.as_str())) {
                                // Python decodes TEXT as UTF-8 and fails the whole query on a bad cell.
                                (false, true) => json_cell(pyjson::parse(text.ok()?), unparsed),
                                (false, false) => Value::String(text.ok()?.to_owned()),
                                // A BLOB stays bytes there: JSON of them, else nothing to read
                                // (protobuf nodes can share a table with JSON messages).
                                (true, true) => json_cell(pyjson::parse_bytes(bytes), unparsed),
                                (true, false) => text.map_or(Value::Null, |t| Value::String(t.to_owned())),
                            }
                        }
                    }
                    _ => Value::Null,
                };
                row.insert(name.clone(), value);
            }
            rows.push(Row { value: Value::Object(row), blobs });
        }
        Some(rows)
    }

    fn joined(&self, sql: &str) -> Option<String> {
        let statement = self.prepare(sql, &[])?;
        let mut out = String::new();
        loop {
            match unsafe { sqlite3_step(statement.0) } {
                DONE => return Some(out),
                ROW => {}
                _ => return None,
            }
            // The type first: reading a BLOB's bytes as text makes SQLite
            // report the cell as TEXT afterwards.
            let kind = unsafe { sqlite3_column_type(statement.0, 0) };
            let bytes = unsafe { cell(statement.0, 0) };
            match kind {
                4 => out.push_str(&ignore_invalid(bytes)),
                // A TEXT cell that is not UTF-8 fails main's whole query.
                3 => out.push_str(std::str::from_utf8(bytes).ok()?),
                _ => {}
            }
        }
    }
}

/// A JSON column's cell. Text neither parser reads (a plain-text cell that
/// shares the column, a protobuf blob) is nothing to read; text only Python's
/// `json` may read is nothing too, but marks the call as Python's.
fn json_cell(parsed: Parsed, unparsed: &Cell<bool>) -> Value {
    match parsed {
        Parsed::Value(value) => value,
        Parsed::Rejected => Value::Null,
        Parsed::Python => {
            unparsed.set(true);
            Value::Null
        }
    }
}

/// The bytes of a TEXT or BLOB cell (valid until the next step).
unsafe fn cell<'s>(statement: *mut c_void, column: c_int) -> &'s [u8] {
    let pointer = unsafe { sqlite3_column_text(statement, column) };
    let length = unsafe { sqlite3_column_bytes(statement, column) } as usize;
    if pointer.is_null() || length == 0 { &[] } else { unsafe { std::slice::from_raw_parts(pointer, length) } }
}

/// A bound query parameter.
#[derive(Clone, Copy)]
pub enum Param<'a> {
    Int(i64),
    Text(&'a str),
}

/// One row: its columns as a JSON object, its binary columns as bytes.
pub struct Row {
    pub value: Value,
    pub blobs: Vec<Blob>,
}

/// One database, open for one observer call.
pub struct Db {
    connection: Connection,
    json: &'static [&'static str],
    binary: &'static [&'static str],
    unparsed: Cell<bool>,
    /// Opened `immutable=1` (see `Connection::open`): the path to look beside.
    immutable: Option<std::path::PathBuf>,
}

impl Db {
    /// `Ok(None)`: the database cannot be read this cycle. A store without
    /// the declared columns is `Error::Unsupported`: the caller's own reader
    /// takes the call (main's readers report such a store).
    pub fn open(
        path: &Path,
        json: &'static [&'static str],
        binary: &'static [&'static str],
        requires: &[(&str, &[&str])],
    ) -> Result<Option<Db>, Error> {
        let Some((connection, immutable)) = Connection::open(path) else { return Ok(None) };
        for (table, columns) in requires {
            let Some(have) = connection.query(&format!("PRAGMA table_info({table})"), &[], &[], &[], &Cell::new(false)) else { return Ok(None) };
            let has = |column: &str| have.iter().any(|row| row.value.get("name").and_then(Value::as_str) == Some(column));
            if let Some(missing) = columns.iter().find(|c| !has(c)) {
                return Err(Error::Unsupported(format!("table {table} lacks {missing}")));
            }
        }
        Ok(Some(Db { connection, json, binary, unparsed: Cell::new(false), immutable: immutable.then(|| path.to_owned()) }))
    }

    /// Whether a `-wal` has appeared beside a database this call read with
    /// `immutable=1`: a writer started meanwhile, and rows it committed are in
    /// that file where this read could not see them, while main's `mode=ro`
    /// would. The read is not kept; the caller's reader makes it.
    pub fn wal_appeared(&self) -> bool {
        self.immutable.as_deref().is_some_and(|path| beside(path, "-wal").exists())
    }

    /// The rows of `sql`; `None`: not readable this cycle.
    pub fn rows(&self, sql: &str, params: &[Param]) -> Option<Vec<Row>> {
        self.connection.query(sql, params, self.json, self.binary, &self.unparsed)
    }

    /// Whether a JSON column the rows read so far held text this parser
    /// rejects and Python's `json` may read. Such a cell reads as nothing
    /// (`Null`), which is only right if Python rejects it too: the caller
    /// hands the call to its own reader instead of committing past the row.
    pub fn unparsed(&self) -> bool {
        self.unparsed.get()
    }

    /// The first column of every row of `sql`, bytes decoded as UTF-8 with
    /// invalid sequences dropped (Python `errors="ignore"`), concatenated.
    /// `None`: the query failed.
    pub fn joined(&self, sql: &str) -> Option<String> {
        self.connection.joined(sql)
    }
}

#[cfg(test)]
pub(crate) mod testing {
    //! A database a test can write: the crate itself only ever reads one.
    use super::*;

    #[cfg_attr(target_os = "macos", link(name = "sqlite3"))]
    #[cfg_attr(windows, link(name = "winsqlite3", kind = "raw-dylib"))]
    unsafe extern "C" {
        fn sqlite3_exec(db: *mut c_void, sql: *const c_char, callback: *const c_void, arg: *mut c_void, error: *mut *mut c_char) -> c_int;
    }

    /// Run `sql` against the database at `path`, creating it.
    pub fn write(path: &Path, sql: &str) {
        const READ_WRITE_CREATE: c_int = 2 | 4;
        let name = CString::new(path.to_str().unwrap()).unwrap();
        let sql = CString::new(sql).unwrap();
        let mut raw = std::ptr::null_mut();
        assert_eq!(unsafe { sqlite3_open_v2(name.as_ptr(), &mut raw, READ_WRITE_CREATE, std::ptr::null()) }, 0);
        let db = Connection(raw);
        assert_eq!(unsafe { sqlite3_exec(db.0, sql.as_ptr(), std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut()) }, 0);
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    /// A JSON column cell this parser rejects reads as nothing, and the call
    /// is the caller's reader's only if Python's `json` may read the cell: a
    /// plain-text cell that shares the column, a blank one, a protobuf blob
    /// and text that is not JSON to anyone are not.
    #[test]
    fn a_json_cell_that_only_python_may_read_hands_the_call_over() {
        #[cfg(unix)]
        let _no_fork = crate::session::FD_FORK_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let store = crate::observe::file::tempfile_lite::TempFile::new("json-cells");
        testing::write(
            &store.path,
            "CREATE TABLE t (id INTEGER PRIMARY KEY, data); \
             INSERT INTO t (data) VALUES ('{\"a\":1}'), (''), (x'12FF66696C653A2F2F2F757372'), (NULL), ('plain text'), ('not json'), (x'7B226122'); \
             INSERT INTO t (data) VALUES ('{\"a\":\"cut \\ud83d\"}'), ('{\"a\":NaN}'), (x'7B2261223A4E614E7D');",
        );
        let db = Db::open(&store.path, &["data"], &[], &[]).unwrap().unwrap();
        let rows = db.rows("SELECT data FROM t WHERE id <= 7 ORDER BY id", &[]).unwrap();
        assert_eq!(rows[0].value["data"], serde_json::json!({"a": 1}));
        assert!(!db.unparsed(), "valid JSON, a blank cell, a protobuf blob, NULL, plain text and corrupt JSON are nothing to hand over");
        for (id, what) in [(8, "a lone surrogate"), (9, "NaN"), (10, "a blob of NaN")] {
            let db = Db::open(&store.path, &["data"], &[], &[]).unwrap().unwrap();
            let rows = db.rows("SELECT data FROM t WHERE id = ?", &[Param::Int(id)]).unwrap();
            assert!(rows[0].value["data"].is_null(), "{what} reads as nothing");
            assert!(db.unparsed(), "{what} is handed over");
        }
    }

    /// A WAL database whose last writer closed has no `-wal`/`-shm`: it is
    /// opened `mode=ro` as main does, and `immutable=1` only where the system
    /// SQLite refuses that (macOS's did where this was written; a build that
    /// reads it `mode=ro` takes the first branch and the test still holds).
    /// Either way its rows are read, and a `-wal` that appears after an
    /// immutable read is noticed.
    #[test]
    fn a_wal_database_without_sidecars_is_read_and_a_wal_that_appears_after_an_immutable_read_is_noticed() {
        #[cfg(unix)]
        let _no_fork = crate::session::FD_FORK_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let store = crate::observe::file::tempfile_lite::TempFile::new("wal-closed");
        testing::write(&store.path, "PRAGMA journal_mode=WAL; CREATE TABLE t (n); INSERT INTO t VALUES (7); PRAGMA wal_checkpoint(TRUNCATE)");
        assert!(wal_header(&store.path), "the fixture is a WAL database");
        // Every row is in the database file now; a writer that closed cleanly
        // leaves no sidecars, which some SQLite builds do not do for this helper.
        for suffix in ["-wal", "-shm"] {
            let _ = std::fs::remove_file(beside(&store.path, suffix));
        }
        let db = Db::open(&store.path, &[], &[], &[]).unwrap().expect("a closed WAL database can be read");
        assert_eq!(db.rows("SELECT n FROM t", &[]).unwrap()[0].value["n"], 7);
        assert!(!db.wal_appeared());
        let immutable = db.immutable.is_some();
        std::fs::write(beside(&store.path, "-wal"), b"").unwrap();
        assert_eq!(db.wal_appeared(), immutable, "only a read that ignored the -wal needs to be handed over");
        // A database that is not WAL and cannot be opened stays refused: no second try.
        let bad = crate::observe::file::tempfile_lite::TempFile::new("not-a-db");
        std::fs::write(&bad.path, b"this is not a database at all, it is longer than the header is").unwrap();
        assert!(Db::open(&bad.path, &[], &[], &[]).unwrap().is_none());
    }

    #[test]
    fn a_blob_that_is_not_utf8_is_joined_as_a_blob() {
        // No child is forked while this connection is open: on macOS, a PTY
        // child spawned by `session`'s tests in that window was killed
        // (signal 9) before it wrote anything, in about one run in five
        // (see `session::FD_FORK_LOCK`).
        #[cfg(unix)]
        let _no_fork = crate::session::FD_FORK_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let store = crate::observe::file::tempfile_lite::TempFile::new("joined");
        // A protobuf-like blob: a byte that is not UTF-8, then text; and a TEXT row.
        testing::write(&store.path, "CREATE TABLE t (data); INSERT INTO t VALUES (x'12FF66696C653A2F2F2F757372'), ('z')");
        let db = Db::open(&store.path, &[], &[], &[]).unwrap().unwrap();
        assert_eq!(db.joined("SELECT data FROM t ORDER BY rowid").as_deref(), Some("\u{12}file:///usrz"));
    }
}
