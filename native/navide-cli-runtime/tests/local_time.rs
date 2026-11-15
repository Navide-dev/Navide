//! A timestamp without an offset is local time, as Python's
//! `datetime.fromisoformat(…).timestamp()` reads it. One test, in its own
//! process, because it sets `TZ` for the process.
#![cfg(unix)]
use navide_cli_runtime::time::sort_key;

unsafe extern "C" {
    /// POSIX `tzset(3)`: re-read `TZ`.
    fn tzset();
}

fn in_zone(zone: &str) {
    std::env::set_var("TZ", zone);
    // SAFETY: this test binary has one test, so no other thread reads the zone.
    unsafe { tzset() };
}

#[test]
fn a_naive_stamp_is_read_in_the_local_zone() {
    // Values from Python: datetime.fromisoformat(s).timestamp() under each TZ.
    in_zone("Asia/Tokyo");
    assert_eq!(sort_key("2026-01-01T00:00:00"), Some(1_767_193_200.0), "UTC+9: nine hours before UTC midnight");
    assert_eq!(sort_key("2026-07-29T08:00:00.250"), Some(1_785_279_600.25));
    assert_eq!(sort_key("2026-01-01T00:00:00Z"), Some(1_767_225_600.0), "an explicit offset is untouched");
    assert_eq!(sort_key("2026-01-01T09:00:00+09:00"), Some(1_767_225_600.0));

    in_zone("America/New_York");
    assert_eq!(sort_key("2026-01-01T00:00:00"), Some(1_767_243_600.0), "EST, UTC-5");
    assert_eq!(sort_key("2026-07-01T00:00:00"), Some(1_782_878_400.0), "EDT, UTC-4");
    // 2026-11-01 01:30 happens twice; `fold=0` is the first (EDT).
    assert_eq!(sort_key("2026-11-01T01:30:00"), Some(1_793_511_000.0));
    // 2026-03-08 02:30 does not exist; Python moves it forward across the gap.
    assert_eq!(sort_key("2026-03-08T02:30:00"), Some(1_772_955_000.0));

    in_zone("UTC");
    assert_eq!(sort_key("2026-01-01T00:00:00"), Some(1_767_225_600.0));
}
