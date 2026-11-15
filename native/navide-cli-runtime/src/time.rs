//! UTC calendar arithmetic for the few timestamp conversions the readers make.

fn days_to_civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn civil_to_days(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn stamp(whole: i64, millis: i64) -> String {
    let (days, secs) = (whole.div_euclid(86_400), whole.rem_euclid(86_400));
    let (y, m, d) = days_to_civil(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z", secs / 3600, secs % 3600 / 60, secs % 60)
}

/// grok's `_iso`: `strftime(gmtime(s))` plus `int((s % 1) * 1000)` milliseconds.
pub fn iso_truncated_ms(seconds: f64) -> String {
    let whole = seconds.floor();
    stamp(whole as i64, (((seconds - whole) * 1000.0) as i64).clamp(0, 999))
}

/// `datetime.fromtimestamp(micros / 1e6, timezone.utc).isoformat()`: no
/// fraction when it is zero; "" outside `datetime`'s years 1..=9999.
pub fn iso_from_micros(micros: i64) -> String {
    let (whole, frac) = (micros.div_euclid(1_000_000), micros.rem_euclid(1_000_000));
    let (days, secs) = (whole.div_euclid(86_400), whole.rem_euclid(86_400));
    let (y, m, d) = days_to_civil(days);
    if !(1..=9999).contains(&y) {
        return String::new();
    }
    let fraction = if frac == 0 { String::new() } else { format!(".{frac:06}") };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}{fraction}+00:00", secs / 3600, secs % 3600 / 60, secs % 60)
}

/// `datetime.fromtimestamp(seconds, timezone.utc).isoformat()` of a float:
/// the fraction rounded half-even to microseconds, as CPython does.
pub fn iso_from_float(seconds: f64) -> String {
    if !seconds.is_finite() || seconds.abs() > 3.0e11 {
        return String::new();
    }
    let whole = seconds.trunc();
    let micros = ((seconds - whole) * 1e6).round_ties_even();
    iso_from_micros(whole as i64 * 1_000_000 + micros as i64)
}

/// `log_readers.base.turn_timestamp`: epoch-ms strings become ISO 8601
/// (microsecond-rounded, then truncated to ms, as `datetime` does), ISO passes
/// through, "" becomes None.
pub fn turn_timestamp(raw: &str) -> Option<String> {
    if raw.is_empty() {
        return None;
    }
    match raw.trim().parse::<f64>() {
        Ok(ms) if ms.is_finite() => {
            let micros = (ms * 1000.0).round_ties_even() as i64;
            let whole = micros.div_euclid(1_000_000);
            Some(stamp(whole, micros.rem_euclid(1_000_000) / 1000))
        }
        _ => Some(raw.to_owned()),
    }
}

/// `log_readers.base._turn_sort_key`: seconds since the epoch for an epoch-ms
/// string or an ISO 8601 stamp. A stamp without an offset is local time, as
/// `datetime.fromisoformat(…).timestamp()` reads it.
pub fn sort_key(raw: &str) -> Option<f64> {
    if raw.is_empty() {
        return None;
    }
    if let Ok(ms) = raw.trim().parse::<f64>() {
        return Some(ms / 1000.0);
    }
    parse_iso(raw)
}

/// The local wall clock at `utc` seconds since the epoch, as the seconds the
/// same wall clock would be in UTC.
#[cfg(unix)]
fn local_wall(utc: i64) -> Option<i64> {
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let at = utc as libc::time_t;
    // SAFETY: both pointers are to live values of the right types.
    if unsafe { libc::localtime_r(&at, &mut tm) }.is_null() {
        return None;
    }
    let days = civil_to_days(i64::from(tm.tm_year) + 1900, tm.tm_mon as u32 + 1, tm.tm_mday as u32);
    Some(days * 86_400 + i64::from(tm.tm_hour) * 3600 + i64::from(tm.tm_min) * 60 + i64::from(tm.tm_sec))
}

/// Not built off Unix (the runtime observes nothing there): UTC.
#[cfg(not(unix))]
fn local_wall(utc: i64) -> Option<i64> {
    Some(utc)
}

/// CPython's `local_to_seconds` with `fold=0`: the UTC second whose local
/// wall clock is `wall`. In a repeated hour it is the earlier one; in a
/// skipped hour, the time the clock would show had it not jumped.
fn local_to_utc(wall: i64) -> Option<i64> {
    const MAX_FOLD_SECONDS: i64 = 24 * 3600;
    let a = local_wall(wall)? - wall;
    let u1 = wall - a;
    let t1 = local_wall(u1)?;
    let b = if t1 == wall {
        // One solution; an earlier one exists when the offset changed just before.
        let u2 = u1 - MAX_FOLD_SECONDS;
        let b = local_wall(u2)? - u2;
        if a == b {
            return Some(u1);
        }
        b
    } else {
        t1 - u1
    };
    let u2 = wall - b;
    if local_wall(u2)? == wall {
        return Some(u2);
    }
    if t1 == wall {
        return Some(u1);
    }
    // Neither offset maps back: `wall` is in a gap.
    Some(u1.max(u2))
}

pub fn parse_iso(raw: &str) -> Option<f64> {
    let b = raw.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let s = raw.get(from..from + len)?;
        s.bytes().all(|c| c.is_ascii_digit()).then(|| s.parse().ok())?
    };
    let (y, mo, d) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let mut wall = civil_to_days(y, mo as u32, d as u32) * 86_400;
    let mut fraction = 0.0;
    // Seconds east of UTC; `None`: the stamp names none (local time).
    let mut offset = None;
    let mut i = 10;
    if i < b.len() {
        if b[i] != b'T' && b[i] != b' ' {
            return None;
        }
        let (h, mi) = (num(i + 1, 2)?, num(i + 4, 2)?);
        if b.get(i + 3) != Some(&b':') {
            return None;
        }
        wall += h * 3600 + mi * 60;
        i += 6;
        if b.get(i) == Some(&b':') {
            wall += num(i + 1, 2)?;
            i += 3;
            if matches!(b.get(i), Some(b'.') | Some(b',')) {
                let start = i + 1;
                let mut end = start;
                while end < b.len() && b[end].is_ascii_digit() {
                    end += 1;
                }
                if end == start {
                    return None;
                }
                fraction = format!("0.{}", &raw[start..end]).parse::<f64>().ok()?;
                i = end;
            }
        }
        match b.get(i) {
            None => {}
            Some(b'Z') if i + 1 == b.len() => offset = Some(0),
            Some(sign @ (b'+' | b'-')) => {
                let (oh, om) = (num(i + 1, 2)?, num(i + 4, 2)?);
                let east = oh * 3600 + om * 60;
                offset = Some(if *sign == b'+' { east } else { -east });
            }
            _ => return None,
        }
    }
    let utc = match offset {
        Some(east) => wall - east,
        None => local_to_utc(wall)?,
    };
    Some(utc as f64 + fraction)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversions_round_trip() {
        assert_eq!(turn_timestamp("1700000000123").unwrap(), "2023-11-14T22:13:20.123Z");
        assert_eq!(turn_timestamp("2026-01-01T00:00:00Z").unwrap(), "2026-01-01T00:00:00Z");
        assert_eq!(iso_truncated_ms(1_700_000_000.5), "2023-11-14T22:13:20.500Z");
        assert_eq!(parse_iso("2023-11-14T22:13:20.123Z"), Some(1_700_000_000.123));
        assert_eq!(parse_iso("2023-11-14T23:13:20+01:00"), Some(1_700_000_000.0));
        assert_eq!(sort_key(""), None);
        assert_eq!(iso_from_micros(1_700_000_000_000_000), "2023-11-14T22:13:20+00:00");
        assert_eq!(iso_from_micros(1_700_000_000_000_042), "2023-11-14T22:13:20.000042+00:00");
    }
}
