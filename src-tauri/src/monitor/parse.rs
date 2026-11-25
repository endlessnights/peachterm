// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Parsing of the fixed monitoring command's output. Remote output is untrusted:
//! everything is length-bounded, numbers are validated, and only sanitized
//! numeric values ever leave this module.

use serde::Serialize;

/// Which metrics are collected (a disabled metric is not even requested).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Wanted {
    pub cpu: bool,
    pub ram: bool,
    pub disk: bool,
    pub uptime: bool,
}

impl Wanted {
    pub fn any(self) -> bool {
        self.cpu || self.ram || self.disk || self.uptime
    }
}

/// The fixed command. Built only from these constants (never from user input),
/// read-only, no `sudo`, no writes, no PTY. It is wrapped in `sh -c '…'` so that a
/// non-POSIX login shell (fish, csh) still runs it the same way.
pub fn command(w: Wanted) -> String {
    let mut s = String::from("LC_ALL=C; export LC_ALL");
    if w.cpu {
        s.push_str("; echo @@stat; head -n 1 /proc/stat; echo @@load; head -n 1 /proc/loadavg");
    }
    if w.ram {
        s.push_str("; echo @@mem; grep -e MemTotal: -e MemAvailable: /proc/meminfo");
    }
    if w.uptime {
        s.push_str("; echo @@up; head -n 1 /proc/uptime");
    }
    if w.disk {
        s.push_str("; echo @@df; df -P -k /");
    }
    format!("sh -c '{s}'")
}

/// Cumulative CPU counters of the aggregate `cpu` line of `/proc/stat`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CpuCounters {
    /// Everything that is not idle (guest time is already part of user/nice).
    pub busy: u64,
    /// idle + iowait.
    pub idle: u64,
}

impl CpuCounters {
    fn total(self) -> u64 {
        self.busy.saturating_add(self.idle)
    }
}

/// `cpu  user nice system idle iowait irq softirq steal guest guest_nice`
///
/// Semantics: `busy = user + nice + system + irq + softirq + steal`,
/// `idle = idle + iowait`; `guest` and `guest_nice` are **not** added again
/// because the kernel already counts them inside `user` and `nice`.
pub fn parse_stat(line: &str) -> Option<CpuCounters> {
    let mut it = line.split_whitespace();
    if it.next()? != "cpu" {
        return None;
    }
    let mut n = [0u64; 8];
    // user nice system idle iowait irq softirq steal (older kernels have fewer)
    let mut seen = 0;
    for slot in n.iter_mut() {
        match it.next() {
            Some(t) => {
                *slot = t.parse().ok()?;
                seen += 1;
            }
            None => break,
        }
    }
    if seen < 4 {
        return None;
    }
    let [user, nice, system, idle, iowait, irq, softirq, steal] = n;
    let busy = user
        .checked_add(nice)?
        .checked_add(system)?
        .checked_add(irq)?
        .checked_add(softirq)?
        .checked_add(steal)?;
    Some(CpuCounters {
        busy,
        idle: idle.checked_add(iowait)?,
    })
}

/// CPU utilisation (0–100) between two samples, or `None` when it cannot be
/// computed honestly (no baseline, counters went backwards, nothing elapsed).
pub fn cpu_percent(prev: Option<CpuCounters>, now: CpuCounters) -> Option<f32> {
    let prev = prev?;
    if now.busy < prev.busy || now.idle < prev.idle {
        return None; // reset or hotplug: start a new baseline
    }
    let busy = now.busy - prev.busy;
    let total = now.total().checked_sub(prev.total())?;
    if total == 0 {
        return None;
    }
    Some((busy as f64 / total as f64 * 100.0).clamp(0.0, 100.0) as f32)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub used_kib: u64,
    pub total_kib: u64,
    pub available_kib: u64,
}

pub fn parse_meminfo(text: &str) -> Option<Memory> {
    let (mut total, mut avail) = (None, None);
    for line in text.lines().take(64) {
        let (key, rest) = line.split_once(':')?;
        let value = || -> Option<u64> {
            let mut p = rest.split_whitespace();
            let v: u64 = p.next()?.parse().ok()?;
            match p.next() {
                Some("kB") | None => Some(v),
                _ => None,
            }
        };
        match key {
            "MemTotal" => total = value(),
            "MemAvailable" => avail = value(),
            _ => {}
        }
    }
    let (total, avail) = (total?, avail?);
    if total == 0 || avail > total {
        return None;
    }
    Some(Memory {
        used_kib: total - avail,
        total_kib: total,
        available_kib: avail,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub used_kib: u64,
    pub total_kib: u64,
    pub available_kib: u64,
    /// `used / (used + available)`, as `df` computes its capacity column.
    pub percent: f32,
}

/// Output of `df -P -k /`. The filesystem name may contain spaces, so the
/// numbers are read from the right.
pub fn parse_df(text: &str) -> Option<Disk> {
    let line = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .nth(1)?;
    let tokens: Vec<&str> = line.split_whitespace().collect();
    if tokens.len() < 6 {
        return None;
    }
    let n = tokens.len();
    if tokens[n - 1] != "/" {
        return None; // the mount point is not the root filesystem
    }
    if !tokens[n - 2].ends_with('%') {
        return None;
    }
    let avail: u64 = tokens[n - 3].parse().ok()?;
    let used: u64 = tokens[n - 4].parse().ok()?;
    let total: u64 = tokens[n - 5].parse().ok()?;
    let denom = used.checked_add(avail)?;
    if total == 0 || denom == 0 {
        return None;
    }
    Some(Disk {
        used_kib: used,
        total_kib: total,
        available_kib: avail,
        percent: (used as f64 / denom as f64 * 100.0).clamp(0.0, 100.0) as f32,
    })
}

pub fn parse_uptime(text: &str) -> Option<u64> {
    let v: f64 = text.split_whitespace().next()?.parse().ok()?;
    if !v.is_finite() || !(0.0..=1.0e10).contains(&v) {
        return None;
    }
    Some(v as u64)
}

pub fn parse_load(text: &str) -> Option<[f32; 3]> {
    let mut it = text.split_whitespace();
    let mut out = [0f32; 3];
    for slot in out.iter_mut() {
        let v: f32 = it.next()?.parse().ok()?;
        if !v.is_finite() || !(0.0..=1.0e6).contains(&v) {
            return None;
        }
        *slot = v;
    }
    Some(out)
}

/// What the renderer receives: sanitized numbers only, never remote text.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub cpu_percent: Option<f32>,
    pub load: Option<[f32; 3]>,
    pub memory: Option<Memory>,
    pub disk: Option<Disk>,
    pub uptime_secs: Option<u64>,
}

/// Raw sections of one run.
#[derive(Debug, Default, PartialEq)]
pub struct Sections<'a> {
    pub stat: Option<&'a str>,
    pub load: Option<&'a str>,
    pub mem: Option<&'a str>,
    pub up: Option<&'a str>,
    pub df: Option<&'a str>,
}

pub fn split_sections(text: &str) -> Sections<'_> {
    fn assign<'a>(out: &mut Sections<'a>, cur: Option<(&str, usize)>, end: usize, text: &'a str) {
        let Some((name, start)) = cur else { return };
        let body = text[start..end].trim();
        if body.is_empty() {
            return;
        }
        match name {
            "stat" => out.stat = Some(body),
            "load" => out.load = Some(body),
            "mem" => out.mem = Some(body),
            "up" => out.up = Some(body),
            "df" => out.df = Some(body),
            _ => {}
        }
    }
    let mut out = Sections::default();
    let mut current: Option<(&str, usize)> = None;
    let mut offset = 0;
    for line in text.split_inclusive(char::from(10)) {
        if let Some(name) = line.trim_end().strip_prefix("@@") {
            assign(&mut out, current, offset, text);
            current = Some((name, offset + line.len()));
        }
        offset += line.len();
    }
    assign(&mut out, current, text.len(), text);
    out
}

/// Counters for the next CPU delta, taken from a run.
pub fn counters_of(sections: &Sections<'_>) -> Option<CpuCounters> {
    sections.stat.and_then(parse_stat)
}

/// Build metrics from a run. `prev` is the previous CPU baseline.
pub fn metrics_of(sections: &Sections<'_>, prev: Option<CpuCounters>) -> Metrics {
    Metrics {
        cpu_percent: counters_of(sections).and_then(|now| cpu_percent(prev, now)),
        load: sections.load.and_then(parse_load),
        memory: sections.mem.and_then(parse_meminfo),
        disk: sections.df.and_then(parse_df),
        uptime_secs: sections.up.and_then(parse_uptime),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: Wanted = Wanted {
        cpu: true,
        ram: true,
        disk: true,
        uptime: true,
    };

    #[test]
    fn the_command_is_fixed_and_only_asks_for_enabled_metrics() {
        let c = command(ALL);
        assert!(c.starts_with("sh -c '") && c.ends_with('\''));
        for needle in ["/proc/stat", "/proc/meminfo", "/proc/uptime", "df -P -k /"] {
            assert!(c.contains(needle), "{needle}");
        }
        assert!(!c.contains("sudo") && !c.contains('>') && !c.contains("rm "));
        let only_ram = command(Wanted {
            cpu: false,
            ram: true,
            disk: false,
            uptime: false,
        });
        assert!(only_ram.contains("meminfo") && !only_ram.contains("/proc/stat"));
        assert!(!only_ram.contains("df "));
    }

    #[test]
    fn cpu_counters_leave_out_guest_time_and_merge_iowait_into_idle() {
        // user nice system idle iowait irq softirq steal guest guest_nice
        let c = parse_stat("cpu  100 10 50 800 40 5 5 2 30 3").unwrap();
        assert_eq!(c.busy, 100 + 10 + 50 + 5 + 5 + 2);
        assert_eq!(c.idle, 840);
    }

    #[test]
    fn cpu_percent_from_two_samples() {
        let a = parse_stat("cpu 100 0 100 800 0 0 0 0").unwrap();
        let b = parse_stat("cpu 150 0 150 900 0 0 0 0").unwrap();
        // busy +100, idle +100
        assert_eq!(cpu_percent(Some(a), b), Some(50.0));
        let idle = parse_stat("cpu 150 0 150 1900 0 0 0 0").unwrap();
        assert_eq!(cpu_percent(Some(b), idle), Some(0.0));
    }

    #[test]
    fn iowait_counts_as_idle() {
        let a = parse_stat("cpu 0 0 0 0 0").unwrap();
        let b = parse_stat("cpu 0 0 0 0 100").unwrap();
        assert_eq!(cpu_percent(Some(a), b), Some(0.0));
    }

    #[test]
    fn cpu_has_no_value_without_a_baseline_a_delta_or_with_a_reset() {
        let a = parse_stat("cpu 100 0 100 800").unwrap();
        assert_eq!(cpu_percent(None, a), None);
        assert_eq!(cpu_percent(Some(a), a), None, "zero delta");
        let smaller = parse_stat("cpu 10 0 10 80").unwrap();
        assert_eq!(cpu_percent(Some(a), smaller), None, "counters went back");
        // hotplug: busy grew but idle shrank
        let odd = parse_stat("cpu 200 0 100 700").unwrap();
        assert_eq!(cpu_percent(Some(a), odd), None);
    }

    #[test]
    fn malformed_stat_is_rejected() {
        for bad in [
            "",
            "cpu0 1 2 3 4",
            "cpu 1 2 3",
            "cpu a b c d",
            "cpu 1 2 3 -4",
            "cpu 18446744073709551615 1 0 0",
        ] {
            assert_eq!(parse_stat(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn memory_uses_available_not_free() {
        let m =
            parse_meminfo("MemTotal:       65536000 kB\nMemAvailable:   24641536 kB\n").unwrap();
        assert_eq!(m.total_kib, 65_536_000);
        assert_eq!(m.used_kib, 65_536_000 - 24_641_536);
        assert_eq!(m.available_kib, 24_641_536);
    }

    #[test]
    fn memory_rejects_missing_invalid_or_zero_values() {
        for bad in [
            "",
            "MemTotal: 100 kB",
            "MemAvailable: 100 kB",
            "MemTotal: 0 kB\nMemAvailable: 0 kB",
            "MemTotal: 100 kB\nMemAvailable: 200 kB",
            "MemTotal: x kB\nMemAvailable: 1 kB",
            "MemTotal: 100 MB\nMemAvailable: 1 MB",
            "garbage line",
        ] {
            assert_eq!(parse_meminfo(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn df_parses_the_root_filesystem() {
        let out = "Filesystem     1024-blocks      Used Available Capacity Mounted on\n\
                   /dev/mapper/pve-root 98497780  74125000  19323000      80% /\n";
        let d = parse_df(out).unwrap();
        assert_eq!(d.total_kib, 98_497_780);
        assert_eq!(d.used_kib, 74_125_000);
        assert!((d.percent - 79.32).abs() < 0.1, "{}", d.percent);
    }

    #[test]
    fn df_handles_spaces_in_names_full_disks_and_zfs() {
        let spaced = "Filesystem 1024-blocks Used Available Capacity Mounted on\n\
                      my odd fs 1000 400 600 40% /\n";
        assert_eq!(parse_df(spaced).unwrap().percent, 40.0);
        let full = "h\nrpool/ROOT/pve-1 1000 1000 0 100% /\n";
        assert_eq!(parse_df(full).unwrap().percent, 100.0);
    }

    #[test]
    fn df_rejects_other_mounts_and_malformed_output() {
        for bad in [
            "",
            "header only",
            "h\n/dev/sda1 1000 400 600 40% /boot",
            "h\nshort 1 2",
            "h\n/dev/sda1 x 400 600 40% /",
            "h\n/dev/sda1 0 0 0 0% /",
            "h\n/dev/sda1 1000 400 600 40 /",
        ] {
            assert_eq!(parse_df(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn uptime_and_load() {
        assert_eq!(parse_uptime("1067712.31 4000000.50"), Some(1_067_712));
        assert_eq!(parse_uptime("0.00 0.00"), Some(0));
        assert_eq!(parse_uptime("315360000.0 1"), Some(315_360_000));
        for bad in ["", "abc", "-5 1", "NaN 1", "1e99 1"] {
            assert_eq!(parse_uptime(bad), None, "{bad:?}");
        }
        assert_eq!(
            parse_load("0.42 0.51 0.38 1/200 123"),
            Some([0.42, 0.51, 0.38])
        );
        assert_eq!(parse_load("0.4 0.5"), None);
        assert_eq!(parse_load("a b c"), None);
    }

    #[test]
    fn sections_are_split_and_a_full_run_is_parsed() {
        let out = "@@stat\ncpu 100 0 100 800 0 0 0 0\n@@load\n0.1 0.2 0.3 1/2 3\n@@mem\n\
                   MemTotal: 1000 kB\nMemAvailable: 400 kB\n@@up\n99.9 1\n@@df\nh\nx 100 25 75 25% /\n";
        let s = split_sections(out);
        let prev = parse_stat("cpu 0 0 0 0").unwrap();
        let m = metrics_of(&s, Some(prev));
        assert_eq!(m.cpu_percent, Some(20.0));
        assert_eq!(m.memory.unwrap().used_kib, 600);
        assert_eq!(m.disk.unwrap().percent, 25.0);
        assert_eq!(m.uptime_secs, Some(99));
        assert_eq!(m.load, Some([0.1, 0.2, 0.3]));
    }

    #[test]
    fn missing_proc_gives_empty_sections_not_made_up_numbers() {
        let s = split_sections("@@stat\n@@mem\n@@up\n@@df\n");
        assert_eq!(s, Sections::default());
        assert_eq!(metrics_of(&s, None), Metrics::default());
        let garbage = split_sections("hello\nworld\n");
        assert_eq!(garbage, Sections::default());
    }
}
