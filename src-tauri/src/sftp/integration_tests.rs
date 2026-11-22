// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! SFTP against the in-process test server (real SSH transport, real SFTP
//! protocol, a temporary directory as the remote file system).

use super::put::{Expectation, PutOptions, Stamp, put_file, remote_sha256, stamp};
use super::transfer::{Hub, TransferEvent, run_download, run_upload};
use super::{Client, SftpError, SftpState, ops};
use crate::ssh::integration::{Started, env, start_session, target, trust_and_password};
use crate::ssh::testserver::{Opts, TestServer};
use crate::ssh::testsftp::SftpOpts;
use crate::ssh::{SessionState, TerminalEvent};
use crate::storage::connections::AuthMethod;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use uuid::Uuid;

struct Fixture {
    _server: TestServer,
    _env: crate::ssh::integration::Env,
    session: Started,
    client: Arc<Client>,
    root: tempfile::TempDir,
}

async fn fixture(sftp: SftpOpts) -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let server = TestServer::start(Opts {
        users: vec![("tester".into(), "pw".into())],
        sftp_root: Some(root.path().to_path_buf()),
        sftp: Arc::new(sftp),
        ..Default::default()
    })
    .await;
    let env = env(trust_and_password("pw"));
    let session = start_session(
        &env,
        target(server.port, "tester", AuthMethod::Password),
        None,
    );
    session
        .sink
        .wait_until("sftp ready", |s| s.sftp_state() == Some(SftpState::Ready))
        .await;
    let client = session.session.sftp.client().expect("client after ready");
    Fixture {
        _server: server,
        _env: env,
        session,
        client,
        root,
    }
}

fn no_cancel() -> AtomicBool {
    AtomicBool::new(false)
}

async fn put(
    f: &Fixture,
    remote: &str,
    data: &[u8],
    overwrite: bool,
    expect: Option<&Expectation>,
) -> Result<super::put::PutOutcome, SftpError> {
    put_file(
        &f.client,
        std::io::Cursor::new(data.to_vec()),
        remote,
        PutOptions { overwrite, expect },
        &no_cancel(),
        &mut |_| {},
    )
    .await
}

fn leftovers(root: &std::path::Path) -> Vec<String> {
    std::fs::read_dir(root)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains("peachterm"))
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_without_sftp_leaves_the_terminal_working() {
    let server = TestServer::start(Opts {
        users: vec![("tester".into(), "pw".into())],
        ..Default::default()
    })
    .await;
    let env = env(trust_and_password("pw"));
    let s = start_session(
        &env,
        target(server.port, "tester", AuthMethod::Password),
        None,
    );
    s.sink
        .wait_until("sftp state", |k| {
            k.sftp_state() == Some(SftpState::Unavailable)
        })
        .await;
    assert!(s.session.sftp.client().is_none());
    assert_eq!(s.session.state(), SessionState::Connected);
    // the shell still works
    s.session.write(b"still alive\n".to_vec()).await;
    s.sink
        .wait_until("echo", |k| k.text().contains("still alive"))
        .await;
    assert!(s.sink.closed_reason().is_none());
    s.session.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn browsing_lists_names_sizes_times_and_permissions() {
    let f = fixture(SftpOpts::default()).await;
    std::fs::create_dir(f.root.path().join("docs")).unwrap();
    std::fs::write(f.root.path().join("a.txt"), b"hello").unwrap();
    std::fs::write(f.root.path().join(".hidden"), b"").unwrap();
    std::fs::write(f.root.path().join("docs").join("b.md"), b"# b").unwrap();

    let top = ops::list(&f.client, None).await.unwrap();
    assert_eq!(top.path, "/");
    assert_eq!(top.parent, None);
    let mut names: Vec<_> = top.entries.iter().map(|e| e.name.as_str()).collect();
    names.sort();
    assert_eq!(names, [".hidden", "a.txt", "docs"]);
    let a = top.entries.iter().find(|e| e.name == "a.txt").unwrap();
    assert_eq!((a.size, a.path.as_str()), (5, "/a.txt"));
    assert!(a.modified.is_some_and(|m| m > 1_000_000_000));
    assert!(a.mode.is_some());
    let docs = top.entries.iter().find(|e| e.name == "docs").unwrap();
    assert_eq!(docs.kind, ops::EntryKind::Directory);

    let sub = ops::list(&f.client, Some("/docs")).await.unwrap();
    assert_eq!(sub.parent.as_deref(), Some("/"));
    assert_eq!(sub.entries.len(), 1);
    assert_eq!(sub.entries[0].path, "/docs/b.md");

    assert_eq!(
        ops::list(&f.client, Some("/nope")).await.unwrap_err(),
        SftpError::NotFound
    );
    assert_eq!(
        ops::list(&f.client, Some("/a.txt")).await.unwrap_err(),
        SftpError::NotADirectory
    );
    assert_eq!(
        ops::list(&f.client, Some("/a\nb")).await.unwrap_err(),
        SftpError::InvalidPath
    );
    // the SSH terminal is unaffected by SFTP use
    assert_eq!(f.session.session.state(), SessionState::Connected);
}

#[tokio::test(flavor = "multi_thread")]
async fn mkdir_rename_and_delete_with_validation() {
    let f = fixture(SftpOpts::default()).await;
    assert_eq!(
        ops::mkdir(&f.client, "/", "projects").await.unwrap(),
        "/projects"
    );
    assert!(f.root.path().join("projects").is_dir());
    assert_eq!(
        ops::mkdir(&f.client, "/", "projects").await.unwrap_err(),
        SftpError::AlreadyExists
    );
    for bad in ["", "..", "a/b", "x\ny"] {
        assert_eq!(
            ops::mkdir(&f.client, "/", bad).await.unwrap_err(),
            SftpError::InvalidPath,
            "{bad:?}"
        );
    }

    std::fs::write(f.root.path().join("projects").join("one.txt"), b"1").unwrap();
    std::fs::write(f.root.path().join("two.txt"), b"2").unwrap();
    assert_eq!(
        ops::rename(&f.client, "/projects/one.txt", "uno.txt")
            .await
            .unwrap(),
        "/projects/uno.txt"
    );
    assert!(f.root.path().join("projects").join("uno.txt").exists());
    // never overwrites
    std::fs::write(f.root.path().join("projects").join("taken.txt"), b"t").unwrap();
    assert_eq!(
        ops::rename(&f.client, "/projects/uno.txt", "taken.txt")
            .await
            .unwrap_err(),
        SftpError::AlreadyExists
    );
    assert_eq!(
        ops::rename(&f.client, "/projects/uno.txt", "../escape")
            .await
            .unwrap_err(),
        SftpError::InvalidPath
    );

    // recursive delete counts what it removed
    std::fs::create_dir_all(f.root.path().join("projects/deep/er")).unwrap();
    std::fs::write(f.root.path().join("projects/deep/er/x"), b"x").unwrap();
    let removed = ops::delete(&f.client, "/projects").await.unwrap();
    assert_eq!(removed, 6); // uno, taken, x, er, deep, projects
    assert!(!f.root.path().join("projects").exists());
    assert_eq!(ops::delete(&f.client, "/two.txt").await.unwrap(), 1);
    // refuses to delete the root or relative paths
    for bad in ["/", "", ".", "..", "relative/path"] {
        assert_eq!(
            ops::delete(&f.client, bad).await.unwrap_err(),
            SftpError::InvalidPath,
            "{bad:?}"
        );
    }
    assert_eq!(
        ops::delete(&f.client, "/missing").await.unwrap_err(),
        SftpError::NotFound
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn uploads_create_replace_and_never_leave_temporary_files() {
    let f = fixture(SftpOpts {
        posix_rename: true,
        ..Default::default()
    })
    .await;
    let created = put(&f, "/new.txt", b"first", false, None).await.unwrap();
    assert_eq!(
        (created.bytes, created.replaced, created.atomic),
        (5, false, true)
    );
    assert_eq!(
        std::fs::read(f.root.path().join("new.txt")).unwrap(),
        b"first"
    );

    // an existing target is only replaced when allowed
    assert_eq!(
        put(&f, "/new.txt", b"second", false, None)
            .await
            .unwrap_err(),
        SftpError::AlreadyExists
    );
    assert_eq!(
        std::fs::read(f.root.path().join("new.txt")).unwrap(),
        b"first"
    );
    let replaced = put(&f, "/new.txt", b"second!", true, None).await.unwrap();
    assert!(
        replaced.replaced && replaced.atomic,
        "posix-rename is atomic"
    );
    assert_eq!(
        std::fs::read(f.root.path().join("new.txt")).unwrap(),
        b"second!"
    );
    assert_eq!(replaced.stamp.size, 7);
    assert!(leftovers(f.root.path()).is_empty());

    // directories and bad paths are refused
    std::fs::create_dir(f.root.path().join("d")).unwrap();
    assert_eq!(
        put(&f, "/d", b"x", true, None).await.unwrap_err(),
        SftpError::IsADirectory
    );
    for bad in ["relative.txt", "/trailing/", ""] {
        assert_eq!(
            put(&f, bad, b"x", true, None).await.unwrap_err(),
            SftpError::InvalidPath,
            "{bad:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn without_posix_rename_the_replacement_is_reported_as_not_atomic() {
    let f = fixture(SftpOpts::default()).await;
    std::fs::write(f.root.path().join("f.txt"), b"old").unwrap();
    let outcome = put(&f, "/f.txt", b"newer", true, None).await.unwrap();
    assert!(outcome.replaced);
    assert!(!outcome.atomic, "no false atomicity claim");
    assert_eq!(
        std::fs::read(f.root.path().join("f.txt")).unwrap(),
        b"newer"
    );
    assert!(
        leftovers(f.root.path()).is_empty(),
        "backup and temp files are cleaned up"
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn replacing_a_file_keeps_its_permission_bits() {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture(SftpOpts {
        posix_rename: true,
        ..Default::default()
    })
    .await;
    let path = f.root.path().join("script.sh");
    std::fs::write(&path, b"#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o750)).unwrap();
    put(&f, "/script.sh", b"#!/bin/sh\necho hi\n", true, None)
        .await
        .unwrap();
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o7777;
    assert_eq!(mode, 0o750);
}

#[tokio::test(flavor = "multi_thread")]
async fn interrupted_and_cancelled_uploads_leave_the_target_untouched() {
    // the server starts failing writes after 100 KiB
    let f = fixture(SftpOpts {
        posix_rename: true,
        fail_write_after: Some(100 * 1024),
        ..Default::default()
    })
    .await;
    std::fs::write(f.root.path().join("keep.txt"), b"original").unwrap();
    let big = vec![7u8; 600 * 1024];
    let err = put(&f, "/keep.txt", &big, true, None).await.unwrap_err();
    assert_eq!(err, SftpError::Failed);
    assert_eq!(
        std::fs::read(f.root.path().join("keep.txt")).unwrap(),
        b"original"
    );
    assert!(
        leftovers(f.root.path()).is_empty(),
        "partial temp file removed"
    );
    // the SSH session survives a failed transfer
    assert_eq!(f.session.session.state(), SessionState::Connected);

    // cancellation
    let f2 = fixture(SftpOpts {
        posix_rename: true,
        ..Default::default()
    })
    .await;
    std::fs::write(f2.root.path().join("keep.txt"), b"original").unwrap();
    let cancel = AtomicBool::new(false);
    let mut seen = 0u64;
    let mut cancel_after = |done: u64| {
        seen = done;
        if done >= 64 * 1024 {
            cancel.store(true, Ordering::Relaxed);
        }
    };
    let err = put_file(
        &f2.client,
        std::io::Cursor::new(vec![1u8; 1024 * 1024]),
        "/keep.txt",
        PutOptions {
            overwrite: true,
            expect: None,
        },
        &cancel,
        &mut cancel_after,
    )
    .await
    .unwrap_err();
    assert_eq!(err, SftpError::Cancelled);
    assert!(seen < 1024 * 1024);
    assert_eq!(
        std::fs::read(f2.root.path().join("keep.txt")).unwrap(),
        b"original"
    );
    assert!(leftovers(f2.root.path()).is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_changed_remote_file_is_detected_before_it_is_overwritten() {
    let f = fixture(SftpOpts {
        posix_rename: true,
        ..Default::default()
    })
    .await;
    let path = f.root.path().join("conf.ini");
    std::fs::write(&path, b"v1 content").unwrap();
    let st = stamp(&f.client, "/conf.ini").await.unwrap().unwrap();
    let hash = remote_sha256(&f.client, "/conf.ini").await.unwrap();
    let expect = Expectation {
        stamp: st,
        sha256: Some(hash),
    };

    // unchanged: allowed
    put(&f, "/conf.ini", b"v1 edited", true, Some(&expect))
        .await
        .unwrap();

    // someone else changes the file (different size)
    std::fs::write(&path, b"changed by someone else!").unwrap();
    let err = put(&f, "/conf.ini", b"my edit", true, Some(&expect))
        .await
        .unwrap_err();
    assert_eq!(err, SftpError::RemoteChanged);
    assert_eq!(
        std::fs::read(&path).unwrap(),
        b"changed by someone else!",
        "the other change is untouched"
    );

    // same size and mtime but different content: the hash catches it
    std::fs::write(&path, b"AAAAAAAAAA").unwrap();
    let st = stamp(&f.client, "/conf.ini").await.unwrap().unwrap();
    let expect = Expectation {
        stamp: st,
        sha256: Some(<sha2::Sha256 as sha2::Digest>::digest(b"BBBBBBBBBB").into()),
    };
    assert_eq!(
        put(&f, "/conf.ini", b"mine", true, Some(&expect))
            .await
            .unwrap_err(),
        SftpError::RemoteChanged
    );
    assert!(leftovers(f.root.path()).is_empty());

    // the file was deleted remotely: also a conflict, nothing is recreated
    std::fs::remove_file(&path).unwrap();
    let gone = Expectation {
        stamp: Stamp {
            size: 10,
            mtime: None,
        },
        sha256: None,
    };
    // a missing target is not "existing": it is simply created (documented)
    assert!(
        put(&f, "/conf.ini", b"fresh", true, Some(&gone))
            .await
            .is_ok()
    );
}

type Events = Arc<Mutex<Vec<TransferEvent>>>;

fn recorder() -> (Events, impl Fn(TransferEvent) + Send + Sync) {
    let events: Events = Arc::default();
    let sink = events.clone();
    (events, move |e| sink.lock().unwrap().push(e))
}

#[tokio::test(flavor = "multi_thread")]
async fn download_reports_progress_and_writes_atomically() {
    let f = fixture(SftpOpts::default()).await;
    let data: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(f.root.path().join("big.bin"), &data).unwrap();
    let local = tempfile::tempdir().unwrap();
    let dest = local.path().join("copy.bin");
    let hub = Hub::default();
    let (events, emit) = recorder();
    let n = run_download(&f.client, &hub, Uuid::new_v4(), "/big.bin", &dest, &emit)
        .await
        .unwrap();
    assert_eq!(n, data.len() as u64);
    assert_eq!(std::fs::read(&dest).unwrap(), data);
    let events = events.lock().unwrap();
    assert!(matches!(
        events.first(),
        Some(TransferEvent::Started { total: 300_000, .. })
    ));
    assert!(
        events
            .iter()
            .any(|e| matches!(e, TransferEvent::Progress { .. }))
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, TransferEvent::Completed { bytes: 300_000, .. }))
    );
    assert!(matches!(events.last(), Some(TransferEvent::Finished)));
    assert!(
        std::fs::read_dir(local.path()).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("part")),
        "no .part file is left behind"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn download_failures_leave_nothing_at_the_destination() {
    let f = fixture(SftpOpts::default()).await;
    std::fs::create_dir(f.root.path().join("dir")).unwrap();
    let local = tempfile::tempdir().unwrap();
    let hub = Hub::default();
    let (events, emit) = recorder();
    let dest = local.path().join("x");
    let err = run_download(&f.client, &hub, Uuid::new_v4(), "/dir", &dest, &emit)
        .await
        .unwrap_err();
    assert_eq!(err, SftpError::IsADirectory);
    let err = run_download(&f.client, &hub, Uuid::new_v4(), "/missing", &dest, &emit)
        .await
        .unwrap_err();
    assert_eq!(err, SftpError::NotFound);
    assert!(!dest.exists());
    assert_eq!(std::fs::read_dir(local.path()).unwrap().count(), 0);
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .all(|e| !matches!(e, TransferEvent::Completed { .. }))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_download_can_be_cancelled() {
    let f = fixture(SftpOpts::default()).await;
    std::fs::write(f.root.path().join("big.bin"), vec![3u8; 8 * 1024 * 1024]).unwrap();
    let local = tempfile::tempdir().unwrap();
    let dest = local.path().join("big.bin");
    let hub = Arc::new(Hub::default());
    let events: Events = Arc::default();
    let (ev, hub2) = (events.clone(), hub.clone());
    let emit = move |e: TransferEvent| {
        if let TransferEvent::Started { transfer_id, .. } = &e {
            hub2.cancel(*transfer_id); // cancel immediately after it starts
        }
        ev.lock().unwrap().push(e);
    };
    let err = run_download(&f.client, &hub, Uuid::new_v4(), "/big.bin", &dest, &emit)
        .await
        .unwrap_err();
    assert_eq!(err, SftpError::Cancelled);
    assert!(!dest.exists());
    assert_eq!(std::fs::read_dir(local.path()).unwrap().count(), 0);
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, TransferEvent::Cancelled { .. }))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn batch_upload_continues_after_a_conflict_and_reports_each_file() {
    let f = fixture(SftpOpts {
        posix_rename: true,
        ..Default::default()
    })
    .await;
    let local = tempfile::tempdir().unwrap();
    let files: Vec<_> = ["a.txt", "b.txt", "c.txt"]
        .iter()
        .map(|n| {
            let p = local.path().join(n);
            std::fs::write(&p, n.as_bytes()).unwrap();
            p
        })
        .collect();
    std::fs::write(f.root.path().join("b.txt"), b"already there").unwrap();
    let hub = Hub::default();
    let (events, emit) = recorder();
    run_upload(&f.client, &hub, Uuid::new_v4(), &files, "/", false, &emit).await;
    let first = events.lock().unwrap().clone();
    let completed = first
        .iter()
        .filter(|e| matches!(e, TransferEvent::Completed { .. }))
        .count();
    let failed: Vec<_> = first
        .iter()
        .filter_map(|e| match e {
            TransferEvent::Failed { reason, .. } => Some(reason.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(completed, 2);
    assert_eq!(failed, ["already_exists"]);
    assert!(matches!(first.last(), Some(TransferEvent::Finished)));
    assert_eq!(
        std::fs::read(f.root.path().join("a.txt")).unwrap(),
        b"a.txt"
    );
    assert_eq!(
        std::fs::read(f.root.path().join("b.txt")).unwrap(),
        b"already there",
        "the existing file was not touched"
    );

    // with overwrite the conflicting file is replaced
    let (events, emit) = recorder();
    run_upload(
        &f.client,
        &hub,
        Uuid::new_v4(),
        &files[1..2],
        "/",
        true,
        &emit,
    )
    .await;
    assert_eq!(
        std::fs::read(f.root.path().join("b.txt")).unwrap(),
        b"b.txt"
    );
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, TransferEvent::Completed { .. }))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn picked_files_are_single_use() {
    let hub = Hub::default();
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("f.txt");
    std::fs::write(&p, b"12345").unwrap();
    let (id, files) = hub.remember_pick(vec![p.clone()]);
    assert_eq!((files[0].name.as_str(), files[0].size), ("f.txt", 5));
    assert_eq!(hub.take_pick(id), Some(vec![p]));
    assert_eq!(hub.take_pick(id), None, "second use is refused");
    assert_eq!(hub.take_pick(Uuid::new_v4()), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn after_the_session_ends_sftp_calls_fail_cleanly() {
    let f = fixture(SftpOpts::default()).await;
    f.session.session.close().await;
    f.session
        .sink
        .wait_until("closed", |k| k.closed_reason().is_some())
        .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let err = ops::list(&f.client, None).await.unwrap_err();
    assert!(
        matches!(
            err,
            SftpError::Unavailable | SftpError::Timeout | SftpError::Failed
        ),
        "{err:?}"
    );
}

#[test]
fn state_events_serialize_for_the_renderer() {
    let json = serde_json::to_value(TerminalEvent::Sftp {
        state: SftpState::Ready,
    })
    .unwrap();
    assert_eq!(json["kind"], "sftp");
    assert_eq!(json["state"], "ready");
}

#[tokio::test(flavor = "multi_thread")]
async fn creating_an_empty_file_uses_sftp_and_never_replaces_anything() {
    let f = fixture(SftpOpts::default()).await;
    std::fs::create_dir(f.root.path().join("docs")).unwrap();

    let path = ops::create_file(&f.client, "/docs", "notes.txt")
        .await
        .unwrap();
    assert_eq!(
        path, "/docs/notes.txt",
        "created in the directory that was asked for"
    );
    let created = f.root.path().join("docs").join("notes.txt");
    assert_eq!(std::fs::metadata(&created).unwrap().len(), 0, "zero bytes");
    assert!(!f.root.path().join("notes.txt").exists(), "not in the root");

    // an existing file is never touched
    std::fs::write(&created, b"precious").unwrap();
    assert_eq!(
        ops::create_file(&f.client, "/docs", "notes.txt")
            .await
            .unwrap_err(),
        SftpError::AlreadyExists
    );
    assert_eq!(std::fs::read(&created).unwrap(), b"precious");
    // nor is a directory of that name
    std::fs::create_dir(f.root.path().join("docs").join("sub")).unwrap();
    assert_eq!(
        ops::create_file(&f.client, "/docs", "sub")
            .await
            .unwrap_err(),
        SftpError::AlreadyExists
    );

    // names are validated in Rust as well
    for bad in ["", ".", "..", "a/b", "line\nbreak", &"x".repeat(300)] {
        assert_eq!(
            ops::create_file(&f.client, "/docs", bad).await.unwrap_err(),
            SftpError::InvalidPath,
            "{bad:?}"
        );
    }
    assert_eq!(
        ops::create_file(&f.client, "", "ok.txt").await.unwrap_err(),
        SftpError::InvalidPath
    );
    // nothing else appeared
    let mut names: Vec<_> = std::fs::read_dir(f.root.path().join("docs"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, ["notes.txt", "sub"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn unicode_names_work_for_files_and_folders() {
    let f = fixture(SftpOpts::default()).await;
    for name in [
        "отчёт 2024 ✓.txt",
        "日本語のファイル.md",
        "naïve café.log",
        "emoji-🍑.txt",
    ] {
        let path = ops::create_file(&f.client, "/", name).await.unwrap();
        assert_eq!(path, format!("/{name}"));
        assert!(f.root.path().join(name).is_file(), "{name}");
    }
    assert_eq!(
        ops::mkdir(&f.client, "/", "папка ✓").await.unwrap(),
        "/папка ✓"
    );
    assert!(f.root.path().join("папка ✓").is_dir());
    let listing = ops::list(&f.client, Some("/")).await.unwrap();
    let mut names: Vec<_> = listing.entries.iter().map(|e| e.name.clone()).collect();
    names.sort();
    assert!(names.contains(&"отчёт 2024 ✓.txt".to_owned()));
    assert!(names.contains(&"папка ✓".to_owned()));
    // a duplicate in another script is still a duplicate
    assert_eq!(
        ops::create_file(&f.client, "/", "日本語のファイル.md")
            .await
            .unwrap_err(),
        SftpError::AlreadyExists
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn permission_errors_are_reported_without_changing_anything() {
    let f = fixture(SftpOpts {
        readonly: true,
        ..Default::default()
    })
    .await;
    assert_eq!(
        ops::create_file(&f.client, "/", "new.txt")
            .await
            .unwrap_err(),
        SftpError::PermissionDenied
    );
    assert_eq!(
        ops::mkdir(&f.client, "/", "newdir").await.unwrap_err(),
        SftpError::PermissionDenied
    );
    assert_eq!(std::fs::read_dir(f.root.path()).unwrap().count(), 0);
    // the SSH session itself is fine and browsing still works
    assert!(ops::list(&f.client, None).await.unwrap().entries.is_empty());
    assert_eq!(f.session.session.state(), SessionState::Connected);
    assert_eq!(
        SftpError::PermissionDenied.message(),
        "Permission denied on the server"
    );
}
