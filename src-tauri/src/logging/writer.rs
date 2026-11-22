// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Background log writer: bounded queue, daily + size-based rotation and
//! age/size retention.
//!
//! Design constraints:
//! * Callers (the UI thread, SSH tasks) never block and never allocate more
//!   than one line: `write_line` is a `try_send`; when the queue is full the
//!   line is dropped and counted.
//! * Failures inside the writer (missing/unwritable directory, full disk) never
//!   go through `tracing` (no feedback loops); they only update `WriterStatus`.
//! * The thread sleeps on the channel; there is no polling.
//! * Only files that match our exact naming pattern are ever deleted, so a
//!   user-chosen directory such as `Documents` is never cleaned of other files.

use super::clock;
use super::layer::{self, LineSink};
use serde_json::{Map, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};

/// Source of "now"; injectable so rotation can be tested without waiting.
pub type Clock = Arc<dyn Fn() -> SystemTime + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(SystemTime::now)
}

pub const QUEUE_DEPTH: usize = 4096;
pub const DEFAULT_MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const RETRY_AFTER: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct WriterConfig {
    pub enabled: bool,
    pub dir: PathBuf,
    pub retention_days: u32,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WriterStatus {
    /// Lines are currently being written to disk.
    pub active: bool,
    /// Why not, as a fixed token (never contains a path).
    pub error: Option<&'static str>,
}

/// Fixed-vocabulary description of an I/O failure.
pub fn io_error_kind(error: &std::io::Error) -> &'static str {
    use std::io::ErrorKind::*;
    match error.kind() {
        PermissionDenied => "permission_denied",
        NotFound => "not_found",
        AlreadyExists => "already_exists",
        NotADirectory => "not_a_directory",
        IsADirectory => "is_a_directory",
        StorageFull | QuotaExceeded => "disk_full",
        ReadOnlyFilesystem => "read_only",
        InvalidInput | InvalidFilename => "invalid_path",
        _ => "io_error",
    }
}

// ---------------------------------------------------------------------------
// File naming and retention (pure, testable)
// ---------------------------------------------------------------------------

const PREFIX: &str = "peachterm-";
const SUFFIX: &str = ".log";

pub fn file_name(date: &str, index: u32) -> String {
    if index == 0 {
        format!("{PREFIX}{date}{SUFFIX}")
    } else {
        format!("{PREFIX}{date}.{index}{SUFFIX}")
    }
}

/// `(day number, index)` for names we create; `None` for anything else.
pub fn parse_file_name(name: &str) -> Option<(i64, u32)> {
    let middle = name.strip_prefix(PREFIX)?.strip_suffix(SUFFIX)?;
    let (date, index) = match middle.split_once('.') {
        Some((date, index)) => (date, index.parse::<u32>().ok().filter(|i| *i > 0)?),
        None => (middle, 0),
    };
    let mut parts = date.split('-');
    let (y, m, d) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || y.len() != 4 || m.len() != 2 || d.len() != 2 {
        return None;
    }
    let (y, m, d) = (
        y.parse::<i64>().ok()?,
        m.parse::<u32>().ok()?,
        d.parse::<u32>().ok()?,
    );
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some((clock::days_from_civil(y, m, d), index))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogFile {
    pub path: PathBuf,
    pub name: String,
    pub day: i64,
    pub index: u32,
    pub bytes: u64,
}

pub fn list_log_files(dir: &Path) -> Vec<LogFile> {
    let mut files: Vec<LogFile> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let (day, index) = parse_file_name(&name)?;
            let meta = entry.metadata().ok().filter(|m| m.is_file())?;
            Some(LogFile {
                path: entry.path(),
                name,
                day,
                index,
                bytes: meta.len(),
            })
        })
        .collect();
    files.sort_by_key(|f| (f.day, f.index));
    files
}

/// Which files to delete: everything older than the retention window, then the
/// oldest remaining files until the total fits `max_total_bytes`. The newest
/// file (the one being written) is never selected.
pub fn plan_prune(
    files: &[LogFile],
    today: i64,
    retention_days: u32,
    max_total_bytes: u64,
) -> Vec<PathBuf> {
    let mut sorted: Vec<&LogFile> = files.iter().collect();
    sorted.sort_by_key(|f| (f.day, f.index));
    let newest = sorted.last().map(|f| f.path.clone());
    let mut doomed = Vec::new();
    let mut kept: Vec<&LogFile> = Vec::new();
    for file in sorted {
        let expired = today - file.day >= retention_days as i64;
        if expired && Some(&file.path) != newest.as_ref() {
            doomed.push(file.path.clone());
        } else {
            kept.push(file);
        }
    }
    let mut total: u64 = kept.iter().map(|f| f.bytes).sum();
    for file in &kept {
        if total <= max_total_bytes {
            break;
        }
        if Some(&file.path) == newest.as_ref() {
            continue;
        }
        total -= file.bytes;
        doomed.push(file.path.clone());
    }
    doomed
}

pub fn prune_dir(dir: &Path, today: i64, retention_days: u32, max_total_bytes: u64) -> usize {
    let files = list_log_files(dir);
    let mut removed = 0;
    for path in plan_prune(&files, today, retention_days, max_total_bytes) {
        if fs::remove_file(path).is_ok() {
            removed += 1;
        }
    }
    removed
}

// ---------------------------------------------------------------------------
// Writer thread
// ---------------------------------------------------------------------------

enum Msg {
    Line(String),
    Configure(WriterConfig, SyncSender<WriterStatus>),
    Flush(SyncSender<()>),
    Shutdown(SyncSender<()>),
}

pub struct FileSink {
    tx: SyncSender<Msg>,
    dropped: Arc<AtomicU64>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

struct OpenFile {
    out: BufWriter<File>,
    day: i64,
    size: u64,
}

struct Worker {
    config: Option<WriterConfig>,
    open: Option<OpenFile>,
    status: WriterStatus,
    retry_at: Option<Instant>,
    dropped: Arc<AtomicU64>,
    reported_dropped: u64,
    clock: Clock,
}

impl Worker {
    fn configure(&mut self, config: WriterConfig) -> WriterStatus {
        self.close();
        self.retry_at = None;
        self.status = WriterStatus::default();
        let enabled = config.enabled;
        self.config = Some(config);
        if enabled {
            // Probe now so the UI learns about a bad directory immediately.
            let now = (self.clock)();
            if self.ensure_open(clock::day_number(now), 0) {
                self.prune(clock::day_number(now));
            }
        }
        self.status.clone()
    }

    fn close(&mut self) {
        if let Some(mut open) = self.open.take() {
            let _ = open.out.flush();
        }
    }

    fn fail(&mut self, error: &std::io::Error) {
        self.close();
        self.status = WriterStatus {
            active: false,
            error: Some(io_error_kind(error)),
        };
        self.retry_at = Some(Instant::now() + RETRY_AFTER);
    }

    /// Make sure a file for `day` with room for `incoming` bytes is open.
    fn ensure_open(&mut self, day: i64, incoming: u64) -> bool {
        let Some(config) = self.config.clone() else {
            return false;
        };
        if let Some(open) = &self.open
            && open.day == day
            && open.size + incoming <= config.max_file_bytes
        {
            return true;
        }
        if self.open.is_none()
            && let Some(at) = self.retry_at
            && Instant::now() < at
        {
            return false;
        }
        self.close();
        if let Err(error) = fs::create_dir_all(&config.dir) {
            self.fail(&error);
            return false;
        }
        // Continue the newest file of this day unless it is full.
        let date = clock::format_date(day);
        let (mut index, mut size) = (0, 0);
        for file in list_log_files(&config.dir)
            .into_iter()
            .filter(|f| f.day == day)
        {
            index = file.index;
            size = file.bytes;
        }
        if size > 0 && size + incoming > config.max_file_bytes {
            index += 1;
            size = 0;
        }
        let path = config.dir.join(file_name(&date, index));
        match OpenOptions::new().create(true).append(true).open(&path) {
            Ok(file) => {
                self.open = Some(OpenFile {
                    out: BufWriter::new(file),
                    day,

                    size,
                });
                self.status = WriterStatus {
                    active: true,
                    error: None,
                };
                self.retry_at = None;
                self.prune(day);
                true
            }
            Err(error) => {
                self.fail(&error);
                false
            }
        }
    }

    fn prune(&self, today: i64) {
        if let Some(config) = &self.config {
            prune_dir(
                &config.dir,
                today,
                config.retention_days,
                config.max_total_bytes,
            );
        }
    }

    fn write(&mut self, line: &str) {
        let enabled = self.config.as_ref().is_some_and(|c| c.enabled);
        if !enabled {
            return;
        }
        let now = (self.clock)();
        let day = clock::day_number(now);

        // Tell the reader that lines were lost, once, before continuing.
        let dropped = self.dropped.load(Ordering::Relaxed);
        if dropped > self.reported_dropped {
            let mut fields = Map::new();
            fields.insert("event".into(), Value::from("logs.dropped"));
            fields.insert("count".into(), Value::from(dropped - self.reported_dropped));
            let notice = layer::render(now, "WARN", "peachterm_lib::logging", fields);
            self.reported_dropped = dropped;
            self.write_raw(day, &notice);
        }
        self.write_raw(day, line);
    }

    fn write_raw(&mut self, day: i64, line: &str) {
        let needed = line.len() as u64 + 1;
        if !self.ensure_open(day, needed) {
            return;
        }
        let Some(open) = self.open.as_mut() else {
            return;
        };
        let result = open
            .out
            .write_all(line.as_bytes())
            .and_then(|()| open.out.write_all(b"\n"));
        match result {
            Ok(()) => open.size += needed,
            Err(error) => self.fail(&error),
        }
    }

    fn flush(&mut self) {
        if let Some(open) = self.open.as_mut()
            && let Err(error) = open.out.flush()
        {
            self.fail(&error);
        }
    }
}

impl FileSink {
    pub fn start(clock: Clock) -> Arc<Self> {
        let (tx, rx) = sync_channel::<Msg>(QUEUE_DEPTH);
        let dropped = Arc::new(AtomicU64::new(0));
        let mut worker = Worker {
            config: None,
            open: None,
            status: WriterStatus::default(),
            retry_at: None,
            dropped: dropped.clone(),
            reported_dropped: 0,
            clock,
        };
        let thread = std::thread::Builder::new()
            .name("peachterm-log-writer".into())
            .spawn(move || {
                'outer: while let Ok(first) = rx.recv() {
                    let mut next = Some(first);
                    // Drain whatever is queued, then flush once while idle.
                    while let Some(msg) = next.take() {
                        match msg {
                            Msg::Line(line) => worker.write(&line),
                            Msg::Configure(config, ack) => {
                                let _ = ack.send(worker.configure(config));
                            }
                            Msg::Flush(ack) => {
                                worker.flush();
                                let _ = ack.send(());
                            }
                            Msg::Shutdown(ack) => {
                                worker.close();
                                let _ = ack.send(());
                                break 'outer;
                            }
                        }
                        next = rx.try_recv().ok();
                    }
                    worker.flush();
                }
                worker.close();
            })
            .ok();
        Arc::new(Self {
            tx,
            dropped,
            thread: Mutex::new(thread),
        })
    }

    /// Apply a configuration and report whether writing works.
    pub fn configure(&self, config: WriterConfig) -> WriterStatus {
        let (ack_tx, ack_rx) = sync_channel(1);
        if self.tx.send(Msg::Configure(config, ack_tx)).is_err() {
            return WriterStatus {
                active: false,
                error: Some("writer_stopped"),
            };
        }
        ack_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap_or(WriterStatus {
                active: false,
                error: Some("timeout"),
            })
    }

    /// Wait (bounded) until everything queued so far is on disk.
    pub fn flush(&self, timeout: Duration) {
        let (ack_tx, ack_rx) = sync_channel(1);
        if self.tx.send(Msg::Flush(ack_tx)).is_ok() {
            let _ = ack_rx.recv_timeout(timeout);
        }
    }

    pub fn shutdown(&self) {
        let (ack_tx, ack_rx) = sync_channel(1);
        if self.tx.send(Msg::Shutdown(ack_tx)).is_ok() {
            let _ = ack_rx.recv_timeout(Duration::from_secs(2));
        }
        if let Some(handle) = self.thread.lock().ok().and_then(|mut t| t.take()) {
            let _ = handle.join();
        }
    }

    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

impl LineSink for FileSink {
    fn write_line(&self, line: String) {
        if self.tx.try_send(Msg::Line(line)).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicI64;

    fn day_cell(day: i64) -> Arc<AtomicI64> {
        Arc::new(AtomicI64::new(day))
    }

    fn test_clock(cell: &Arc<AtomicI64>) -> Clock {
        let cell = cell.clone();
        Arc::new(move || {
            let day = cell.load(Ordering::SeqCst);
            std::time::UNIX_EPOCH + Duration::from_secs(day as u64 * 86_400 + 3600)
        })
    }

    fn config(dir: &Path) -> WriterConfig {
        WriterConfig {
            enabled: true,
            dir: dir.to_path_buf(),
            retention_days: 14,
            max_total_bytes: 100 * 1024 * 1024,
            max_file_bytes: 1024,
        }
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    fn lf(day: i64, index: u32, bytes: u64) -> LogFile {
        let name = file_name(&clock::format_date(day), index);
        LogFile {
            path: PathBuf::from(&name),
            name,
            day,
            index,
            bytes,
        }
    }

    #[test]
    fn file_names_round_trip_and_reject_lookalikes() {
        let day = clock::days_from_civil(2026, 11, 22);
        assert_eq!(parse_file_name("peachterm-2026-11-22.log"), Some((day, 0)));
        assert_eq!(
            parse_file_name("peachterm-2026-11-22.3.log"),
            Some((day, 3))
        );
        for other in [
            "peachterm-2026-11-22.0.log",
            "peachterm-2026-13-22.log",
            "peachterm-26-11-22.log",
            "peachterm-2026-11-22.log.bak",
            "notes.txt",
            "peachterm-2026-11-22.x.log",
            "xpeachterm-2026-11-22.log",
            "../peachterm-2026-11-22.log",
        ] {
            assert_eq!(parse_file_name(other), None, "{other}");
        }
    }

    #[test]
    fn retention_deletes_by_age_but_never_the_newest() {
        let today = clock::days_from_civil(2026, 11, 22);
        let files = vec![
            lf(today - 40, 0, 10),
            lf(today - 14, 0, 10), // exactly at the limit: expired
            lf(today - 13, 0, 10),
            lf(today, 0, 10),
        ];
        let doomed = plan_prune(&files, today, 14, u64::MAX);
        let names: Vec<_> = doomed
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 2);
        assert!(names.iter().any(|n| n.contains("2026-10-13")));
        // Even if everything is expired, the newest file survives.
        let old_only = vec![lf(today - 100, 0, 10), lf(today - 99, 0, 10)];
        assert_eq!(plan_prune(&old_only, today, 7, u64::MAX).len(), 1);
    }

    #[test]
    fn size_cap_removes_oldest_first_and_keeps_current() {
        let today = clock::days_from_civil(2026, 11, 22);
        let files = vec![
            lf(today - 2, 0, 400),
            lf(today - 1, 0, 400),
            lf(today, 0, 400),
        ];
        let doomed = plan_prune(&files, today, 30, 700);
        assert_eq!(doomed.len(), 2);
        assert!(
            doomed[0]
                .to_string_lossy()
                .contains(&clock::format_date(today - 2))
        );
        let doomed = plan_prune(&files, today, 30, 1);
        assert_eq!(doomed.len(), 2, "newest file must be kept");
    }

    #[test]
    fn prune_only_touches_our_own_files() {
        let dir = tempfile::tempdir().unwrap();
        let today = clock::days_from_civil(2026, 11, 22);
        let old = dir
            .path()
            .join(file_name(&clock::format_date(today - 60), 0));
        fs::write(&old, "x").unwrap();
        fs::write(dir.path().join("report.docx"), "precious").unwrap();
        fs::write(dir.path().join("peachterm-notes.txt"), "mine").unwrap();
        fs::write(
            dir.path().join(file_name(&clock::format_date(today), 0)),
            "y",
        )
        .unwrap();
        assert_eq!(prune_dir(dir.path(), today, 7, 1 << 30), 1);
        assert_eq!(
            names(dir.path()),
            vec![
                file_name(&clock::format_date(today), 0),
                "peachterm-notes.txt".into(),
                "report.docx".into()
            ]
        );
    }

    #[test]
    fn writes_lines_and_rotates_by_size_and_by_day() {
        let dir = tempfile::tempdir().unwrap();
        let cell = day_cell(clock::days_from_civil(2026, 11, 22));
        let sink = FileSink::start(test_clock(&cell));
        let status = sink.configure(config(dir.path()));
        assert_eq!(
            status,
            WriterStatus {
                active: true,
                error: None
            }
        );

        let line = "x".repeat(299); // 300 bytes with newline
        for _ in 0..7 {
            sink.write_line(line.clone());
        }
        sink.flush(Duration::from_secs(5));
        let day1 = clock::format_date(cell.load(Ordering::SeqCst));
        // 1024-byte cap: 3 lines per file => 3 files for 7 lines.
        let mut expected = vec![
            file_name(&day1, 0),
            file_name(&day1, 1),
            file_name(&day1, 2),
        ];
        expected.sort();
        assert_eq!(names(dir.path()), expected);
        for f in list_log_files(dir.path()) {
            assert!(f.bytes <= 1024, "{} is {}", f.name, f.bytes);
        }

        cell.fetch_add(1, Ordering::SeqCst);
        sink.write_line("next day".into());
        sink.flush(Duration::from_secs(5));
        let day2 = clock::format_date(cell.load(Ordering::SeqCst));
        assert!(names(dir.path()).contains(&file_name(&day2, 0)));
        let content = fs::read_to_string(dir.path().join(file_name(&day2, 0))).unwrap();
        assert_eq!(content, "next day\n");
        sink.shutdown();
    }

    #[test]
    fn startup_prunes_expired_files_and_appends_to_existing_log() {
        let dir = tempfile::tempdir().unwrap();
        let today = clock::days_from_civil(2026, 11, 22);
        let cell = day_cell(today);
        fs::write(
            dir.path()
                .join(file_name(&clock::format_date(today - 30), 0)),
            "old",
        )
        .unwrap();
        let today_file = dir.path().join(file_name(&clock::format_date(today), 0));
        fs::write(&today_file, "earlier\n").unwrap();
        let sink = FileSink::start(test_clock(&cell));
        sink.configure(config(dir.path()));
        sink.write_line("later".into());
        sink.flush(Duration::from_secs(5));
        assert_eq!(fs::read_to_string(&today_file).unwrap(), "earlier\nlater\n");
        assert_eq!(names(dir.path()).len(), 1, "expired file removed");
        sink.shutdown();
    }

    #[test]
    fn unwritable_directory_reports_status_and_never_panics() {
        let dir = tempfile::tempdir().unwrap();
        let cell = day_cell(clock::days_from_civil(2026, 11, 22));
        // A directory below a regular file can never be created.
        let blocker = dir.path().join("blocker");
        fs::write(&blocker, "x").unwrap();
        let sink = FileSink::start(test_clock(&cell));
        let status = sink.configure(config(&blocker.join("logs")));
        assert!(!status.active);
        assert!(status.error.is_some());
        let shown = format!("{status:?}");
        assert!(
            !shown.contains("blocker"),
            "status must not leak paths: {shown}"
        );
        // Logging into the void is harmless, and recovery works.
        sink.write_line("lost".into());
        sink.flush(Duration::from_secs(5));
        let good = dir.path().join("good");
        assert!(sink.configure(config(&good)).active);
        sink.write_line("kept".into());
        sink.flush(Duration::from_secs(5));
        let text = fs::read_to_string(good.join(file_name(
            &clock::format_date(cell.load(Ordering::SeqCst)),
            0,
        )))
        .unwrap();
        assert_eq!(text, "kept\n");
        sink.shutdown();
    }

    #[test]
    fn disabled_writer_creates_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("logs");
        let sink = FileSink::start(test_clock(&day_cell(20_000)));
        let mut cfg = config(&target);
        cfg.enabled = false;
        let status = sink.configure(cfg);
        assert!(!status.active && status.error.is_none());
        sink.write_line("ignored".into());
        sink.flush(Duration::from_secs(5));
        assert!(!target.exists());
        sink.shutdown();
    }

    #[test]
    fn full_queue_drops_lines_without_blocking_and_reports_it() {
        let dir = tempfile::tempdir().unwrap();
        let cell = day_cell(clock::days_from_civil(2026, 11, 22));
        let sink = FileSink::start(test_clock(&cell));
        sink.configure(config(dir.path()));
        let started = Instant::now();
        for i in 0..(QUEUE_DEPTH * 4) {
            sink.write_line(format!("line {i}"));
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "producer must not block"
        );
        sink.flush(Duration::from_secs(10));
        sink.write_line("after".into());
        sink.flush(Duration::from_secs(10));
        let all: String = list_log_files(dir.path())
            .iter()
            .map(|f| fs::read_to_string(&f.path).unwrap())
            .collect();
        if sink.dropped() > 0 {
            assert!(all.contains("\"event\":\"logs.dropped\""));
        }
        assert!(all.contains("after"));
        sink.shutdown();
    }
}
