//! Which declared rules have matched a record. Off unless a test turns it
//! on: the parity test replays every fixture and then requires that each
//! rule of each declaration matched at least once, so a rule nobody recorded
//! a transcript for is found when it is written, not in production.
//!
//! A rule is known by its address (declarations are statics). While the
//! trace is off, a match costs one relaxed atomic load.
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

static ON: AtomicBool = AtomicBool::new(false);
static MATCHED: Mutex<Option<HashSet<usize>>> = Mutex::new(None);

/// Start (or restart) recording which rules match.
pub fn start() {
    *MATCHED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(HashSet::new());
    ON.store(true, Ordering::Relaxed);
}

/// The rule's condition held for a record.
pub(crate) fn matched<T>(rule: &'static T) {
    if ON.load(Ordering::Relaxed) {
        if let Some(seen) = MATCHED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_mut() {
            seen.insert(std::ptr::from_ref(rule) as usize);
        }
    }
}

/// Whether the rule has matched since `start`.
pub fn has_matched<T>(rule: &'static T) -> bool {
    MATCHED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref().is_some_and(|seen| seen.contains(&(std::ptr::from_ref(rule) as usize)))
}
