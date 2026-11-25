// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! The poller against the in-process SSH test server (real russh on both ends).

use super::parse::Wanted;
use super::*;
use crate::lock::LockFlag;
use crate::ssh::integration::{
    Started, env, password_server, start_session_locked, target, trust_and_password,
};
use crate::ssh::testserver::{ExecMode, TestServer};
use crate::storage::connections::AuthMethod;
use std::sync::atomic::Ordering;

const ALL: Wanted = Wanted {
    cpu: true,
    ram: true,
    disk: true,
    uptime: true,
};

#[derive(Default)]
struct Events(Mutex<Vec<MonitorEvent>>);
impl MonitorSink for Events {
    fn send(&self, e: MonitorEvent) {
        self.0.lock().unwrap().push(e);
    }
}
impl Events {
    fn all(&self) -> Vec<MonitorEvent> {
        self.0.lock().unwrap().clone()
    }
    fn samples(&self) -> Vec<Metrics> {
        self.all()
            .into_iter()
            .filter_map(|e| match e {
                MonitorEvent::Sample { metrics } => Some(metrics),
                _ => None,
            })
            .collect()
    }
}

fn out(cpu: &str) -> Vec<u8> {
    format!(
        "@@stat\n{cpu}\n@@load\n0.50 0.40 0.30 1/100 5\n@@mem\nMemTotal: 1000 kB\nMemAvailable: 250 kB\n\
         @@up\n3700.5 100.0\n@@df\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 720 280 72% /\n"
    )
    .into_bytes()
}

fn cfg(ms: u64) -> MonitorConfig {
    MonitorConfig {
        interval: Duration::from_millis(ms),
        timeout: Duration::from_millis(1500),
        wanted: ALL,
    }
}

async fn connected(server: &TestServer, lock: LockFlag) -> Started {
    let env = env(trust_and_password("pw"));
    let s = start_session_locked(
        &env,
        SessionId::new(),
        target(server.port, "u", AuthMethod::Password),
        None,
        lock,
    );
    s.sink
        .wait_until("shell", |k| k.text().contains("ready"))
        .await;
    for _ in 0..100 {
        if s.session.transport.get().is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // keep the env (host-key policy) alive for the session's lifetime
    std::mem::forget(env);
    s
}

async fn until(what: &str, mut ok: impl FnMut() -> bool) {
    for _ in 0..300 {
        if ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn server(mode: ExecMode) -> TestServer {
    let mut o = password_server("u", "pw");
    o.exec = mode;
    TestServer::start(o).await
}

fn execs(srv: &TestServer) -> usize {
    srv.rec.execs.lock().unwrap().len()
}

#[tokio::test(flavor = "multi_thread")]
async fn polls_over_an_exec_channel_and_the_cpu_needs_two_samples() {
    let srv = server(ExecMode::Outputs(vec![
        out("cpu 100 0 100 800 0 0 0 0"),
        out("cpu 150 0 150 900 0 0 0 0"),
    ]))
    .await;
    let s = connected(&srv, LockFlag::default()).await;
    let engine = Arc::new(MonitorEngine::new(LockFlag::default()));
    let ev = Arc::new(Events::default());
    engine.start(s.session.clone(), cfg(100), ev.clone());
    until("two samples", || ev.samples().len() >= 2).await;
    let samples = ev.samples();
    assert_eq!(samples[0].cpu_percent, None, "no fabricated first reading");
    assert_eq!(samples[1].cpu_percent, Some(50.0));
    let m = samples[1].memory.unwrap();
    assert_eq!((m.used_kib, m.total_kib), (750, 1000));
    assert_eq!(samples[1].disk.unwrap().percent, 72.0);
    assert_eq!(samples[1].uptime_secs, Some(3700));
    assert_eq!(samples[1].load, Some([0.5, 0.4, 0.3]));
    // The fixed command went through exec; nothing was typed into the shell.
    let first = srv.rec.execs.lock().unwrap()[0].clone();
    assert!(first.starts_with("sh -c '") && first.contains("/proc/stat"));
    assert!(srv.rec.input.lock().unwrap().is_empty());
    assert_eq!(srv.rec.shells.load(Ordering::SeqCst), 1);
    engine.stop(s.session.id);
}

#[tokio::test(flavor = "multi_thread")]
async fn only_enabled_metrics_are_requested() {
    let srv = server(ExecMode::Outputs(vec![out("cpu 1 1 1 1")])).await;
    let s = connected(&srv, LockFlag::default()).await;
    let engine = Arc::new(MonitorEngine::new(LockFlag::default()));
    let ev = Arc::new(Events::default());
    let mut c = cfg(100);
    c.wanted = Wanted {
        cpu: false,
        ram: true,
        disk: false,
        uptime: false,
    };
    engine.start(s.session.clone(), c, ev.clone());
    until("a sample", || !ev.samples().is_empty()).await;
    let first = srv.rec.execs.lock().unwrap()[0].clone();
    assert!(first.contains("meminfo") && !first.contains("/proc/stat") && !first.contains("df "));
    engine.stop(s.session.id);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unsupported_server_is_reported_once_and_polling_stops() {
    let srv = server(ExecMode::Outputs(vec![b"@@stat\n@@mem\n".to_vec()])).await;
    let s = connected(&srv, LockFlag::default()).await;
    let engine = Arc::new(MonitorEngine::new(LockFlag::default()));
    let ev = Arc::new(Events::default());
    engine.start(s.session.clone(), cfg(50), ev.clone());
    until("unsupported", || {
        ev.all().iter().any(|e| {
            matches!(
                e,
                MonitorEvent::Unavailable {
                    reason: "unsupported",
                    permanent: true
                }
            )
        })
    })
    .await;
    until("poller gone", || engine.count() == 0).await;
    let n = execs(&srv);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(execs(&srv), n, "no more attempts");
    assert!(ev.samples().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refusing_server_backs_off_and_reports_once() {
    let srv = server(ExecMode::Refuse).await;
    let s = connected(&srv, LockFlag::default()).await;
    let engine = Arc::new(MonitorEngine::new(LockFlag::default()));
    let ev = Arc::new(Events::default());
    engine.start(s.session.clone(), cfg(60), ev.clone());
    until("unavailable", || !ev.all().is_empty()).await;
    tokio::time::sleep(Duration::from_millis(900)).await;
    let notices = ev.all();
    assert_eq!(notices.len(), 1, "no repeated notices: {notices:?}");
    assert!(matches!(
        notices[0],
        MonitorEvent::Unavailable {
            reason: "channel",
            permanent: false
        }
    ));
    // exponential backoff: far fewer attempts than one per interval
    assert!(execs(&srv) <= 6, "{}", execs(&srv));
    assert!(engine.is_running(s.session.id), "transient: still trying");
    engine.stop(s.session.id);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hanging_command_times_out_and_polls_never_overlap() {
    let srv = server(ExecMode::Hang).await;
    let s = connected(&srv, LockFlag::default()).await;
    let engine = Arc::new(MonitorEngine::new(LockFlag::default()));
    let ev = Arc::new(Events::default());
    let mut c = cfg(20);
    c.timeout = Duration::from_millis(400);
    engine.start(s.session.clone(), c, ev.clone());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(execs(&srv), 1, "one poll in flight");
    until("timeout notice", || {
        ev.all().iter().any(|e| {
            matches!(
                e,
                MonitorEvent::Unavailable {
                    reason: "timeout",
                    ..
                }
            )
        })
    })
    .await;
    // the terminal still works while a poll hangs
    assert!(s.session.write(b"x\n".to_vec()).await);
    s.sink.wait_until("echo", |k| k.text().contains('x')).await;
    engine.stop(s.session.id);
}

#[tokio::test(flavor = "multi_thread")]
async fn restarting_never_leaves_a_duplicate_poller() {
    let srv = server(ExecMode::Outputs(vec![out("cpu 1 1 1 1")])).await;
    let s = connected(&srv, LockFlag::default()).await;
    let engine = Arc::new(MonitorEngine::new(LockFlag::default()));
    let ev = Arc::new(Events::default());
    for _ in 0..3 {
        engine.start(s.session.clone(), cfg(200), ev.clone());
    }
    assert_eq!(engine.count(), 1);
    tokio::time::sleep(Duration::from_millis(650)).await;
    // one poller at 200 ms: about 4 runs (plus at most the cancelled starts)
    assert!(execs(&srv) <= 7, "{}", execs(&srv));
    engine.stop(s.session.id);
    assert_eq!(engine.count(), 0);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let n = execs(&srv);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(execs(&srv), n, "stopped means stopped");
}

#[tokio::test(flavor = "multi_thread")]
async fn locking_stops_polling_and_resumes_with_a_new_baseline() {
    let lock = LockFlag::default();
    let srv = server(ExecMode::Outputs(vec![
        out("cpu 100 0 100 800"),
        out("cpu 150 0 150 900"),
        out("cpu 200 0 200 1000"),
    ]))
    .await;
    let s = connected(&srv, lock.clone()).await;
    let engine = Arc::new(MonitorEngine::new(lock.clone()));
    let ev = Arc::new(Events::default());
    lock.set(true);
    engine.start(s.session.clone(), cfg(50), ev.clone());
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(execs(&srv), 0, "no command while locked");
    assert!(ev.all().is_empty(), "nothing delivered while locked");
    lock.set(false);
    until("first sample", || !ev.samples().is_empty()).await;
    assert_eq!(
        ev.samples()[0].cpu_percent,
        None,
        "fresh baseline after unlock"
    );
    engine.stop(s.session.id);
}

#[tokio::test(flavor = "multi_thread")]
async fn ending_the_session_ends_the_poller() {
    let srv = server(ExecMode::Outputs(vec![out("cpu 1 1 1 1")])).await;
    let s = connected(&srv, LockFlag::default()).await;
    let engine = Arc::new(MonitorEngine::new(LockFlag::default()));
    let ev = Arc::new(Events::default());
    engine.start(s.session.clone(), cfg(60), ev.clone());
    until("a sample", || !ev.samples().is_empty()).await;
    s.session.close().await;
    until("poller exits", || engine.count() == 0).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn sessions_are_polled_independently() {
    let a = server(ExecMode::Outputs(vec![out("cpu 1 1 1 1")])).await;
    let b = server(ExecMode::Outputs(vec![out("cpu 1 1 1 1")])).await;
    let sa = connected(&a, LockFlag::default()).await;
    let sb = connected(&b, LockFlag::default()).await;
    let engine = Arc::new(MonitorEngine::new(LockFlag::default()));
    let (ea, eb) = (Arc::new(Events::default()), Arc::new(Events::default()));
    engine.start(sa.session.clone(), cfg(80), ea.clone());
    engine.start(sb.session.clone(), cfg(80), eb.clone());
    assert_eq!(engine.count(), 2);
    until("both", || {
        !ea.samples().is_empty() && !eb.samples().is_empty()
    })
    .await;
    engine.stop(sa.session.id);
    assert_eq!(engine.count(), 1);
    assert!(engine.is_running(sb.session.id));
    engine.stop_all();
}
