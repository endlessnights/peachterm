// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Tunnel integration tests: a real SSH client session against the in-process
//! test server, forwarding to local TCP services. Nothing leaves 127.0.0.1.

use super::engine::{TunnelEngine, TunnelState};
use super::model::{TunnelDef, TunnelKind};
use crate::lock::LockFlag;
use crate::ssh::integration::{Started, env, start_session, target, trust_and_password};
use crate::ssh::testserver::{Forwarding, Opts, TestServer};
use crate::storage::connections::AuthMethod;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use uuid::Uuid;

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// Echoes every byte back (bidirectional streaming check).
async fn echo_service() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let (mut r, mut w) = s.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    port
}

/// A tiny HTTP server (one fixed answer), like a Grafana on the remote loopback.
async fn http_service() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf).await;
                let _ = s
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
                    )
                    .await;
                let _ = s.shutdown().await;
            });
        }
    });
    port
}

struct Fixture {
    server: TestServer,
    started: Started,
    engine: TunnelEngine,
    lock: LockFlag,
    _env: crate::ssh::integration::Env,
}

async fn fixture(forwarding: Forwarding) -> Fixture {
    let server = TestServer::start(Opts {
        users: vec![("tester".into(), "pw".into())],
        forwarding,
        ..Default::default()
    })
    .await;
    let e = env(trust_and_password("pw"));
    let started = start_session(
        &e,
        target(server.port, "tester", AuthMethod::Password),
        None,
    );
    started
        .sink
        .wait_until("shell", |k| k.text().contains("ready"))
        .await;
    let lock = LockFlag::default();
    Fixture {
        server,
        started,
        engine: TunnelEngine::new(lock.clone()),
        lock,
        _env: e,
    }
}

fn def(local: u16, remote: u16) -> TunnelDef {
    TunnelDef {
        id: Uuid::new_v4(),
        connection_id: Uuid::new_v4(),
        kind: TunnelKind::Local,
        name: "t".into(),
        bind_address: "127.0.0.1".into(),
        local_port: local,
        remote_host: "127.0.0.1".into(),
        remote_port: remote,
        auto_start: false,
    }
}

async fn connect(port: u16) -> TcpStream {
    TcpStream::connect(("127.0.0.1", port)).await.unwrap()
}

async fn eventually(what: &str, mut ok: impl FnMut() -> bool) {
    for _ in 0..200 {
        if ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn read_all(mut s: TcpStream) -> Vec<u8> {
    let mut out = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(10), s.read_to_end(&mut out)).await;
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn forwards_http_to_a_service_on_the_servers_loopback() {
    let f = fixture(Forwarding::Allow).await;
    let remote = http_service().await;
    let local = free_port();
    let d = def(local, remote);
    f.engine.start(&d, &f.started.session).unwrap();
    assert_eq!(f.engine.status(d.id).state, TunnelState::Listening);
    let mut s = connect(local).await;
    s.write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
        .await
        .unwrap();
    let body = String::from_utf8(read_all(s).await).unwrap();
    assert!(body.starts_with("HTTP/1.1 200 OK"), "{body}");
    assert!(body.ends_with("hello"));
    assert_eq!(f.server.rec.forward_requests.load(Ordering::SeqCst), 1);
    f.engine.stop(d.id).await;
}

/// Reads until EOF, then answers with the number of bytes it received.
async fn sink_service() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut total = 0u64;
                let mut buf = vec![0u8; 64 * 1024];
                while let Ok(n) = s.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    total += n as u64;
                }
                let _ = s.write_all(&total.to_be_bytes()).await;
                let _ = s.shutdown().await;
            });
        }
    });
    port
}

fn pattern(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

/// Sends `len` patterned bytes to every client, then closes.
async fn source_service(len: usize) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let _ = s.write_all(&pattern(len)).await;
                let _ = s.shutdown().await;
            });
        }
    });
    port
}

// NOTE on the shape of these tests: both ends of the SSH link are russh in one
// process, and russh's session loop writes to the socket inline. Several channels
// that each push bulk data in BOTH directions at once can therefore wedge the
// in-process pair (two writers waiting for each other); a real sshd reads
// independently and does not. The large transfers are thus checked one
// direction at a time with many clients, and full duplex with one big stream
// and with many small ones.
#[tokio::test(flavor = "multi_thread")]
async fn many_clients_upload_and_download_large_data_at_once() {
    const SIZE: usize = 2 * 1024 * 1024;
    let f = fixture(Forwarding::Allow).await;
    let (sink, source) = (sink_service().await, source_service(SIZE).await);
    let (up, down) = (free_port(), free_port());
    let (d_up, d_down) = (def(up, sink), def(down, source));
    f.engine.start(&d_up, &f.started.session).unwrap();
    f.engine.start(&d_down, &f.started.session).unwrap();

    let mut uploads = Vec::new();
    for client in 0..8u8 {
        uploads.push(tokio::spawn(async move {
            let mut s = connect(up).await;
            let data: Vec<u8> = (0..SIZE).map(|i| (i as u8).wrapping_add(client)).collect();
            s.write_all(&data).await.unwrap();
            s.shutdown().await.unwrap(); // half-close: the answer must still arrive
            let mut answer = [0u8; 8];
            tokio::time::timeout(Duration::from_secs(30), s.read_exact(&mut answer))
                .await
                .expect("sink answered")
                .unwrap();
            assert_eq!(u64::from_be_bytes(answer), SIZE as u64, "client {client}");
        }));
    }
    for t in uploads {
        t.await.unwrap();
    }
    let mut downloads = Vec::new();
    for _ in 0..8 {
        downloads.push(tokio::spawn(async move {
            let got = tokio::time::timeout(Duration::from_secs(30), read_all(connect(down).await))
                .await
                .expect("download finished");
            assert!(
                got == pattern(SIZE),
                "downloaded bytes differ ({})",
                got.len()
            );
        }));
    }
    for t in downloads {
        t.await.unwrap();
    }
    assert_eq!(f.server.rec.forward_requests.load(Ordering::SeqCst), 16);
    // the shell on the same transport kept working
    f.started
        .session
        .write(
            b"still-alive
"
            .to_vec(),
        )
        .await;
    f.started
        .sink
        .wait_until("shell echo", |k| k.text().contains("still-alive"))
        .await;
    f.engine.stop_all().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn bidirectional_streaming_one_large_stream_and_many_small_ones() {
    let f = fixture(Forwarding::Allow).await;
    let remote = echo_service().await;
    let local = free_port();
    let d = def(local, remote);
    f.engine.start(&d, &f.started.session).unwrap();

    // one 8 MiB stream in both directions at once, half-closing at the end
    let data = pattern(8 * 1024 * 1024);
    let (mut r, mut w) = connect(local).await.into_split();
    let to_send = data.clone();
    let writer = tokio::spawn(async move {
        w.write_all(&to_send).await.unwrap();
        w.shutdown().await.unwrap();
    });
    let mut got = Vec::new();
    tokio::time::timeout(Duration::from_secs(60), r.read_to_end(&mut got))
        .await
        .expect("echo finished")
        .unwrap();
    writer.await.unwrap();
    assert!(
        got == data,
        "echoed bytes differ ({} of {})",
        got.len(),
        data.len()
    );

    // many simultaneous small request/response conversations
    let mut tasks = Vec::new();
    for client in 0..16u8 {
        tasks.push(tokio::spawn(async move {
            let mut s = connect(local).await;
            for round in 0..20u8 {
                let msg = vec![client.wrapping_add(round); 1000 + usize::from(round) * 37];
                s.write_all(&msg).await.unwrap();
                let mut back = vec![0u8; msg.len()];
                s.read_exact(&mut back).await.unwrap();
                assert_eq!(back, msg);
            }
        }));
    }
    for t in tasks {
        t.await.unwrap();
    }
    f.engine.stop(d.id).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn listens_on_loopback_only_and_refuses_other_addresses() {
    let f = fixture(Forwarding::Allow).await;
    let local = free_port();
    let d = def(local, 1);
    f.engine.start(&d, &f.started.session).unwrap();
    let endpoint = f.engine.endpoint(d.id).unwrap();
    assert!(endpoint.ip().is_loopback(), "{endpoint}");
    f.engine.stop(d.id).await;

    let mut open = def(free_port(), 1);
    open.bind_address = "0.0.0.0".into();
    let err = f.engine.start(&open, &f.started.session).unwrap_err();
    assert!(err.to_string().contains("loopback"), "{err}");
    assert_eq!(f.engine.running_count(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_busy_port_is_reported_and_never_replaced_by_another() {
    let f = fixture(Forwarding::Allow).await;
    let busy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = busy.local_addr().unwrap().port();
    let d = def(port, 1);
    let err = f.engine.start(&d, &f.started.session).unwrap_err();
    assert!(err.to_string().contains("already in use"), "{err}");
    assert_eq!(f.engine.status(d.id).state, TunnelState::Stopped);
    assert_eq!(f.engine.running_count(), 0);
    drop(busy);
    f.engine.start(&d, &f.started.session).unwrap();
    f.engine.stop(d.id).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn no_duplicate_listeners_for_one_tunnel_or_one_endpoint() {
    let f = fixture(Forwarding::Allow).await;
    let local = free_port();
    let d = def(local, 1);
    f.engine.start(&d, &f.started.session).unwrap();
    assert!(
        f.engine
            .start(&d, &f.started.session)
            .unwrap_err()
            .to_string()
            .contains("already running")
    );
    let same_endpoint = def(local, 2);
    assert!(
        f.engine
            .start(&same_endpoint, &f.started.session)
            .unwrap_err()
            .to_string()
            .contains("another running tunnel")
    );
    assert_eq!(f.engine.running_count(), 1);
    f.engine.stop(d.id).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_that_denies_forwarding_is_handled_without_touching_the_shell() {
    let f = fixture(Forwarding::Deny).await;
    let local = free_port();
    let d = def(local, 1234);
    f.engine.start(&d, &f.started.session).unwrap();
    let s = connect(local).await;
    assert!(read_all(s).await.is_empty());
    eventually("denial recorded", || {
        f.engine.status(d.id).last_error.is_some()
    })
    .await;
    let status = f.engine.status(d.id);
    assert!(status.last_error.unwrap().contains("AllowTcpForwarding"));
    // the tunnel keeps listening ("Listening" never claims the remote works)
    assert_eq!(status.state, TunnelState::Listening);
    f.started.session.write(b"shell-ok\n".to_vec()).await;
    f.started
        .sink
        .wait_until("shell", |k| k.text().contains("shell-ok"))
        .await;
    f.engine.stop(d.id).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreachable_destination_closes_only_that_connection() {
    let f = fixture(Forwarding::Allow).await;
    let local = free_port();
    let d = def(local, free_port()); // nothing listens there
    f.engine.start(&d, &f.started.session).unwrap();
    assert!(read_all(connect(local).await).await.is_empty());
    eventually("failure recorded", || {
        f.engine.status(d.id).last_error.is_some()
    })
    .await;
    assert!(
        f.engine
            .status(d.id)
            .last_error
            .unwrap()
            .contains("could not reach")
    );
    // a working destination clears the message afterwards
    let ok = echo_service().await;
    f.engine.stop(d.id).await;
    let d2 = def(local, ok);
    f.engine.start(&d2, &f.started.session).unwrap();
    let mut s = connect(local).await;
    s.write_all(b"ping").await.unwrap();
    let mut buf = [0u8; 4];
    s.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"ping");
    assert!(f.engine.status(d2.id).last_error.is_none());
    f.engine.stop(d2.id).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn stopping_releases_the_port_and_a_restart_works() {
    let f = fixture(Forwarding::Allow).await;
    let remote = echo_service().await;
    let local = free_port();
    let d = def(local, remote);
    for _ in 0..3 {
        f.engine.start(&d, &f.started.session).unwrap();
        let mut s = connect(local).await;
        s.write_all(b"x").await.unwrap();
        let mut b = [0u8; 1];
        s.read_exact(&mut b).await.unwrap();
        f.engine.stop(d.id).await;
        assert_eq!(f.engine.status(d.id).state, TunnelState::Stopped);
        assert!(
            TcpStream::connect(("127.0.0.1", local)).await.is_err(),
            "listener must be gone"
        );
    }
    assert_eq!(f.engine.running_count(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_open_stream_is_cut_when_the_tunnel_stops() {
    let f = fixture(Forwarding::Allow).await;
    let remote = echo_service().await;
    let local = free_port();
    let d = def(local, remote);
    f.engine.start(&d, &f.started.session).unwrap();
    let mut s = connect(local).await;
    s.write_all(b"a").await.unwrap();
    let mut b = [0u8; 1];
    s.read_exact(&mut b).await.unwrap();
    f.engine.stop(d.id).await;
    let mut rest = Vec::new();
    let end = tokio::time::timeout(Duration::from_secs(5), s.read_to_end(&mut rest)).await;
    assert!(end.is_ok(), "the forwarded stream must end");
}

#[tokio::test(flavor = "multi_thread")]
async fn ending_the_ssh_session_stops_its_tunnels() {
    let f = fixture(Forwarding::Allow).await;
    let remote = echo_service().await;
    let local = free_port();
    let d = def(local, remote);
    f.engine.start(&d, &f.started.session).unwrap();
    assert_eq!(
        f.engine.owner(d.id),
        Some(f.started.session.id.uuid()),
        "the tunnel names its owning session"
    );
    f.started.session.close().await;
    f.started
        .sink
        .wait_until("closed", |k| k.closed_reason().is_some())
        .await;
    // what the application does from the session's teardown hook
    assert_eq!(
        f.engine.status(d.id).state,
        TunnelState::ConnectionUnavailable
    );
    f.engine.stop_session(f.started.session.id.uuid());
    assert_eq!(f.engine.status(d.id).state, TunnelState::Stopped);
    eventually("port released", || {
        std::net::TcpStream::connect(("127.0.0.1", local)).is_err()
    })
    .await;
    // a new session can use the same port again; the old transport is not reused
    assert!(
        f.engine
            .start(&d, &f.started.session)
            .unwrap_err()
            .to_string()
            .contains("not ready")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn while_locked_nothing_starts_and_new_connections_are_refused() {
    let f = fixture(Forwarding::Allow).await;
    let remote = echo_service().await;
    let local = free_port();
    let d = def(local, remote);
    f.engine.start(&d, &f.started.session).unwrap();
    let mut open = connect(local).await;
    open.write_all(b"1").await.unwrap();
    let mut b = [0u8; 1];
    open.read_exact(&mut b).await.unwrap();

    f.lock.set(true);
    // a new connection is closed at once and never reaches the server
    let before = f.server.rec.forward_requests.load(Ordering::SeqCst);
    let refused = connect(local).await;
    assert!(read_all(refused).await.is_empty());
    assert_eq!(f.server.rec.forward_requests.load(Ordering::SeqCst), before);
    // starting something new is refused
    let other = def(free_port(), remote);
    assert_eq!(
        f.engine
            .start(&other, &f.started.session)
            .unwrap_err()
            .code(),
        "locked"
    );
    // the stream that was already open runs to its natural end
    open.write_all(b"2").await.unwrap();
    open.read_exact(&mut b).await.unwrap();
    assert_eq!(&b, b"2");

    f.lock.set(false);
    let mut again = connect(local).await;
    again.write_all(b"3").await.unwrap();
    again.read_exact(&mut b).await.unwrap();
    assert_eq!(&b, b"3");
    f.engine.stop(d.id).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn tunnels_do_not_disturb_authentication_or_other_sessions() {
    let f = fixture(Forwarding::Allow).await;
    let remote = echo_service().await;
    let a = def(free_port(), remote);
    let b = def(free_port(), remote);
    f.engine.start(&a, &f.started.session).unwrap();
    f.engine.start(&b, &f.started.session).unwrap();
    assert_eq!(f.engine.running_for_session(f.started.session.id.uuid()), 2);
    // one transport, one authentication: forwarding opened no extra connection
    assert_eq!(f.server.rec.connections.load(Ordering::SeqCst), 1);
    assert_eq!(f.server.rec.auth_attempts.load(Ordering::SeqCst), 1);
    f.engine.stop(a.id).await;
    assert_eq!(f.engine.status(b.id).state, TunnelState::Listening);
    f.engine.stop_all().await;
    assert_eq!(f.engine.running_count(), 0);
}
