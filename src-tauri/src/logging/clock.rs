//! Minimal UTC calendar helpers (no chrono/time dependency).
//!
//! Log files are named by UTC date so rotation and retention are independent
//! of the machine's time zone and DST changes.

use std::time::{SystemTime, UNIX_EPOCH};

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant).
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn since_epoch(now: SystemTime) -> (i64, u64) {
    let secs = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    ((secs / 86_400) as i64, secs % 86_400)
}

pub fn day_number(now: SystemTime) -> i64 {
    since_epoch(now).0
}

/// `YYYY-MM-DD` (UTC).
pub fn format_date(day: i64) -> String {
    let (y, m, d) = civil_from_days(day);
    format!("{y:04}-{m:02}-{d:02}")
}

/// RFC 3339, UTC, microsecond precision.
pub fn format_timestamp(now: SystemTime) -> String {
    let (day, secs) = since_epoch(now);
    let micros = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_micros())
        .unwrap_or(0);
    let (y, m, d) = civil_from_days(day);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{micros:06}Z",
        secs / 3600,
        secs % 3600 / 60,
        secs % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn civil_round_trip() {
        for day in [
            -800_000, -1, 0, 1, 59, 60, 365, 11_016, 20_000, 47_482, 2_000_000,
        ] {
            let (y, m, d) = civil_from_days(day);
            assert_eq!(days_from_civil(y, m, d), day, "{y}-{m}-{d}");
        }
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(days_from_civil(2024, 2, 29)), (2024, 2, 29));
    }

    #[test]
    fn formats_known_instant() {
        // 2026-11-22T13:41:58.000123Z
        let secs = days_from_civil(2026, 11, 22) as u64 * 86_400 + 13 * 3600 + 41 * 60 + 58;
        let t = UNIX_EPOCH + Duration::new(secs, 123_000);
        assert_eq!(format_timestamp(t), "2026-11-22T13:41:58.000123Z");
        assert_eq!(format_date(day_number(t)), "2026-11-22");
    }
}
