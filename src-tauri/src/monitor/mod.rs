// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Live server resource monitor: agentless, read-only, live display only.
//!
//! * One poller task per SSH session (each tab owns its own transport, so tabs
//!   are never mixed up and there is never more than one poller per session).
//! * Each poll opens a short-lived **exec channel** on the session's already
//!   authenticated transport and runs one fixed command (see
//!   [`parse::command`]). Nothing is typed into the interactive shell, no PTY
//!   is used, no extra login happens, no credentials are involved.
//! * Polls never overlap, have a timeout and a size limit, and back off after
//!   failures. A server without a usable `/proc` is reported once as
//!   unsupported and polling stops.
//! * Readings exist only in memory and in the renderer: they are never saved,
//!   logged, exported or sent anywhere. While the application is locked nothing
//!   is polled or delivered.

pub mod parse;

use crate::lock::LockFlag;
use crate::sessions::SessionId;
use crate::ssh::SessionState;
use crate::ssh::session::SshSession;
use parse::{CpuCounters, Metrics, Wanted};
use russh::ChannelMsg;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

/// Upper bound for what one poll may return (the real output is under 1 KiB).
pub const MAX_OUTPUT: usize = 16 * 1024;
pub const POLL_TIMEOUT: Duration = Duration::from_secs(8);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_BACKOFF: Duration = Duration::from_secs(120);
const LOCK_RECHECK: Duration = Duration::from_millis(500);
/// Consecutive runs with no usable data before the server counts as unsupported.
const UNSUPPORTED_AFTER: u32 = 2;

pub const INTERVALS: [u64; 3] = [5, 10, 30];

/// Snap any value to a supported refresh interval (default 10 s).
pub fn normalize_interval(secs: u64) -> u64 {
    if INTERVALS.contains(&secs) { secs } else { 10 }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MonitorEvent {
    /// Fresh sanitized numbers. A `None` field is "not available", never 0.
    Sample { metrics: Metrics },
    /// No fresh data. `permanent`: polling stopped (unsupported server).
    Unavailable {
        reason: &'static str,
        permanent: bool,
    },
}

pub trait MonitorSink: Send + Sync + 'static {
    fn send(&self, event: MonitorEvent);
}

impl MonitorSink for tauri::ipc::Channel<MonitorEvent> {
    fn send(&self, event: MonitorEvent) {
        let _ = tauri::ipc::Channel::send(self, event);
    }
}

#[derive(Debug, Clone, Copy)]
pub struct MonitorConfig {
    pub interval: Duration,
    /// Upper bound for one poll (channel open + command).
    pub timeout: Duration,
    pub wanted: Wanted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fail {
    Channel,
    Timeout,
    TooLarge,
    Failed,
    Cancelled,
}

impl Fail {
    fn token(self) -> &'static str {
        match self {
            Fail::Channel => "channel",
            Fail::Timeout => "timeout",
            Fail::TooLarge => "toolarge",
            Fail::Failed => "failed",
            Fail::Cancelled => "cancelled",
        }
    }
}

struct Running {
    cancel: watch::Sender<bool>,
}

pub struct MonitorEngine {
    lock: LockFlag,
    running: Mutex<HashMap<SessionId, Running>>,
}

impl MonitorEngine {
    pub fn new(lock: LockFlag) -> Self {
        Self {
            lock,
            running: Mutex::new(HashMap::new()),
        }
    }

    /// Number of live pollers (tests and diagnostics; never any readings).
    pub fn count(&self) -> usize {
        self.running.lock().map(|r| r.len()).unwrap_or(0)
    }

    pub fn is_running(&self, id: SessionId) -> bool {
        self.running
            .lock()
            .map(|r| r.contains_key(&id))
            .unwrap_or(false)
    }

    /// Start (or restart with new settings) the poller of one session. Any poller
    /// the session already had is cancelled first, so there is never a duplicate.
    pub fn start(
        self: &Arc<Self>,
        session: Arc<SshSession>,
        config: MonitorConfig,
        sink: Arc<dyn MonitorSink>,
    ) {
        if !config.wanted.any() {
            self.stop(session.id);
            return;
        }
        let (tx, rx) = watch::channel(false);
        let id = session.id;
        if let Ok(mut map) = self.running.lock()
            && let Some(old) = map.insert(id, Running { cancel: tx.clone() })
        {
            let _ = old.cancel.send(true);
        }
        let engine = self.clone();
        tokio::spawn(async move {
            poll_loop(&engine, &session, config, sink, rx.clone()).await;
            // Only forget the entry if it is still ours (a restart replaced it).
            if let Ok(mut map) = engine.running.lock()
                && map.get(&id).is_some_and(|r| r.cancel.same_channel(&tx))
            {
                map.remove(&id);
            }
        });
    }

    pub fn stop(&self, id: SessionId) {
        if let Ok(mut map) = self.running.lock()
            && let Some(r) = map.remove(&id)
        {
            let _ = r.cancel.send(true);
        }
    }

    pub fn stop_all(&self) {
        if let Ok(mut map) = self.running.lock() {
            for (_, r) in map.drain() {
                let _ = r.cancel.send(true);
            }
        }
    }
}

async fn sleep_or_cancel(d: Duration, cancel: &mut watch::Receiver<bool>) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(d) => false,
        _ = cancel.changed() => true,
    }
}

async fn poll_loop(
    engine: &MonitorEngine,
    session: &SshSession,
    config: MonitorConfig,
    sink: Arc<dyn MonitorSink>,
    mut cancel: watch::Receiver<bool>,
) {
    let command = parse::command(config.wanted);
    let mut baseline: Option<CpuCounters> = None;
    let mut failures: u32 = 0;
    let mut empty_runs: u32 = 0;
    let mut last_reason: Option<&'static str> = None;
    loop {
        if *cancel.borrow() {
            return;
        }
        if matches!(
            session.state(),
            SessionState::Disconnected | SessionState::Failed
        ) {
            return;
        }
        // While locked: no commands, no delivery, and the CPU baseline is dropped.
        if engine.lock.is_locked() {
            baseline = None;
            if sleep_or_cancel(LOCK_RECHECK, &mut cancel).await {
                return;
            }
            continue;
        }
        let Some(handle) = session.transport.get() else {
            if sleep_or_cancel(LOCK_RECHECK, &mut cancel).await {
                return;
            }
            continue;
        };
        let result = run_once(handle, &command, config.timeout, &mut cancel).await;
        if *cancel.borrow() || matches!(result, Err(Fail::Cancelled)) {
            return;
        }
        // The lock may have engaged while the command was in flight: drop the result.
        if engine.lock.is_locked() {
            baseline = None;
            continue;
        }
        let mut delay = config.interval;
        match result {
            Ok(output) => {
                let text = String::from_utf8_lossy(&output);
                let sections = parse::split_sections(&text);
                let metrics = parse::metrics_of(&sections, baseline);
                baseline = parse::counters_of(&sections);
                let usable = metrics.cpu_percent.is_some()
                    || baseline.is_some()
                    || metrics.memory.is_some()
                    || metrics.disk.is_some()
                    || metrics.uptime_secs.is_some();
                if usable {
                    failures = 0;
                    empty_runs = 0;
                    last_reason = None;
                    sink.send(MonitorEvent::Sample { metrics });
                } else {
                    empty_runs += 1;
                    if empty_runs >= UNSUPPORTED_AFTER {
                        sink.send(MonitorEvent::Unavailable {
                            reason: "unsupported",
                            permanent: true,
                        });
                        return;
                    }
                    delay = config.interval;
                }
            }
            Err(fail) => {
                baseline = None;
                failures = failures.saturating_add(1);
                let reason = fail.token();
                if last_reason != Some(reason) {
                    sink.send(MonitorEvent::Unavailable {
                        reason,
                        permanent: false,
                    });
                    last_reason = Some(reason);
                }
                let factor = 1u32 << failures.min(5);
                delay = (config.interval * factor).min(MAX_BACKOFF);
            }
        }
        if sleep_or_cancel(delay, &mut cancel).await {
            return;
        }
    }
}

/// One exec-channel round trip: bounded in time and size, always closed.
async fn run_once(
    handle: &crate::ssh::client::Handle,
    command: &str,
    limit: Duration,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Vec<u8>, Fail> {
    let mut channel = tokio::select! {
        r = tokio::time::timeout(limit, handle.channel_open_session()) => match r {
            Ok(Ok(c)) => c,
            Ok(Err(_)) => return Err(Fail::Channel),
            Err(_) => return Err(Fail::Timeout),
        },
        _ = cancel.changed() => return Err(Fail::Cancelled),
    };
    let work = async {
        channel
            .exec(true, command.as_bytes())
            .await
            .map_err(|_| Fail::Channel)?;
        let mut out: Vec<u8> = Vec::new();
        let mut status: Option<u32> = None;
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    if out.len() + data.len() > MAX_OUTPUT {
                        return Err(Fail::TooLarge);
                    }
                    out.extend_from_slice(&data);
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => status = Some(exit_status),
                Some(ChannelMsg::Failure) => return Err(Fail::Channel),
                Some(ChannelMsg::Close) | None => break,
                // Eof: more messages (exit status) may still follow; stderr is ignored.
                Some(_) => {}
            }
        }
        if out.is_empty() && status.is_some_and(|s| s != 0) {
            return Err(Fail::Failed);
        }
        Ok(out)
    };
    let result = tokio::select! {
        r = tokio::time::timeout(limit, work) => r.unwrap_or(Err(Fail::Timeout)),
        _ = cancel.changed() => Err(Fail::Cancelled),
    };
    // Always release the channel, even after a timeout or cancellation.
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, channel.close()).await;
    result
}

#[cfg(test)]
mod integration;

#[cfg(test)]
mod settings_tests {
    use super::*;
    use crate::storage::connections::MonitorMode;
    use crate::storage::settings::Settings;

    #[test]
    fn monitoring_is_off_by_default_and_old_settings_files_still_load() {
        let s = Settings::default();
        assert!(!s.monitoring.enabled);
        assert_eq!(s.monitoring.interval_secs, 10);
        assert!(s.monitoring.cpu && s.monitoring.ram && s.monitoring.disk && s.monitoring.uptime);
        // a settings file written before v0.5.0 has no `monitoring` key
        let old: Settings = serde_json::from_str(r#"{"ssh":{"keepaliveSecs":5}}"#).unwrap();
        assert!(!old.monitoring.enabled);
        assert_eq!(old.ssh.keepalive_secs, 5);
    }

    #[test]
    fn the_interval_snaps_to_the_supported_values() {
        for (given, want) in [(5, 5), (10, 10), (30, 30), (0, 10), (7, 10), (3600, 10)] {
            assert_eq!(normalize_interval(given), want);
        }
        let mut s = Settings::default();
        s.monitoring.interval_secs = 17;
        assert_eq!(s.normalized().monitoring.interval_secs, 10);
    }

    #[test]
    fn a_connection_without_the_field_inherits() {
        assert_eq!(MonitorMode::default(), MonitorMode::Inherit);
        let m: MonitorMode = serde_json::from_str("\"disabled\"").unwrap();
        assert_eq!(m, MonitorMode::Disabled);
    }
}

#[cfg(test)]
mod privacy_tests {
    /// Readings must never reach disk or the logs: the module has no file access,
    /// no logging macros and no serialisation to storage.
    #[test]
    fn the_monitor_never_touches_files_or_logs() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/monitor");
        for name in ["mod.rs", "parse.rs"] {
            let text = std::fs::read_to_string(dir.join(name)).unwrap();
            // only the production part of the file
            let prod = text.split("#[cfg(test)]").next().unwrap();
            for banned in [
                "std::fs",
                "tokio::fs",
                "File::",
                "tracing::",
                "println!",
                "eprintln!",
                "save_json",
                "write_atomic",
            ] {
                assert!(!prod.contains(banned), "{name} must not use {banned}");
            }
        }
    }
}
