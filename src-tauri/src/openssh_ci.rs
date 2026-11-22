//! Smoke tests against a REAL OpenSSH server (the CI job starts a throw-away
//! `openssh-server` container; see `.github/workflows/ci.yml`). They are
//! `#[ignore]`d so a normal `cargo test` never touches the network:
//!
//! ```text
//! PEACHTERM_TEST_OPENSSH=2222:tester:secret cargo test -- --ignored openssh_
//! ```
//!
//! Never point this at a machine you care about: it creates and deletes files
//! in the login directory of the given account.

use crate::editor::policy::UserAnswer;
use crate::editor::service::{EditorEvent, EditorService, OpenParams, Timing};
use crate::lock::LockFlag;
use crate::sessions::SessionRegistry;
use crate::sftp::put::{PutOptions, put_file};
use crate::sftp::{SftpState, ops};
use crate::ssh::integration::{env, start_session_as, target, trust_and_password};
use crate::storage::connections::AuthMethod;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use uuid::Uuid;

fn settings() -> Option<(u16, String, String)> {
    let raw = std::env::var("PEACHTERM_TEST_OPENSSH").ok()?;
    let mut parts = raw.splitn(3, ':');
    let port = parts.next()?.parse().ok()?;
    Some((port, parts.next()?.to_owned(), parts.next()?.to_owned()))
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs PEACHTERM_TEST_OPENSSH (CI starts a container)"]
async fn openssh_terminal_sftp_and_editor_round_trip() {
    let Some((port, user, password)) = settings() else {
        panic!("PEACHTERM_TEST_OPENSSH=port:user:password is required");
    };
    let password: &'static str = Box::leak(password.into_boxed_str());
    let env = env(trust_and_password(password));
    let lock = LockFlag::default();
    let registry = Arc::new(SessionRegistry::with_lock(lock.clone()));
    let id = registry.open(Uuid::new_v4()).unwrap();
    let started = start_session_as(&env, id, target(port, &user, AuthMethod::Password), None);

    // terminal: a real shell answers
    started
        .sink
        .wait_until("sftp ready", |s| s.sftp_state() == Some(SftpState::Ready))
        .await;
    started
        .session
        .write(b"echo peach-$((1+2))\n".to_vec())
        .await;
    started
        .sink
        .wait_until("shell output", |k| k.text().contains("peach-3"))
        .await;
    assert!(started.session.resize(120, 40).await);
    assert_eq!(env.known_hosts.list().unwrap().len(), 1, "host key saved");

    // sftp: browse, create, replace atomically, conflict, delete
    let client = started.session.sftp.client().expect("sftp client");
    let home = ops::list(&client, None).await.unwrap().path;
    let dir = format!(
        "{}/peachterm-ci-{}",
        home.trim_end_matches('/'),
        Uuid::new_v4()
    );
    ops::mkdir(&client, &home, dir.rsplit('/').next().unwrap())
        .await
        .unwrap();
    let file = format!("{dir}/note.txt");
    let cancel = AtomicBool::new(false);
    let created = put_file(
        &client,
        std::io::Cursor::new(b"one".to_vec()),
        &file,
        PutOptions {
            overwrite: false,
            expect: None,
        },
        &cancel,
        &mut |_| {},
    )
    .await
    .unwrap();
    assert!(!created.replaced);
    let replaced = put_file(
        &client,
        std::io::Cursor::new(b"two".to_vec()),
        &file,
        PutOptions {
            overwrite: true,
            expect: None,
        },
        &cancel,
        &mut |_| {},
    )
    .await
    .unwrap();
    assert!(
        replaced.replaced && replaced.atomic,
        "OpenSSH has posix-rename, so replacing must be atomic"
    );

    // editor round trip over the real server
    let events: Arc<Mutex<Vec<EditorEvent>>> = Arc::default();
    let sink = events.clone();
    let editor = EditorService::new(
        registry.clone(),
        lock,
        Arc::new(move |e| sink.lock().unwrap().push(e)),
        Timing {
            poll: Duration::from_millis(30),
            settle: Duration::from_millis(100),
            max_bytes: 1024 * 1024,
        },
    );
    let local = tempfile::tempdir().unwrap();
    let opened = editor
        .open_remote(OpenParams {
            session: id,
            client: client.clone(),
            remote_path: file.clone(),
            temp_root: local.path().to_path_buf(),
            launch: Arc::new(|_| Ok(())),
        })
        .await
        .unwrap();
    let copy = local
        .path()
        .join(opened.edit_id.to_string())
        .join(&opened.name);
    assert_eq!(std::fs::read(&copy).unwrap(), b"two");
    std::thread::sleep(Duration::from_millis(30));
    std::fs::write(&copy, b"three, edited locally").unwrap();
    wait_for(&events, |e| matches!(e, EditorEvent::Confirm { .. })).await;
    assert_eq!(
        client.read(file.clone()).await.unwrap(),
        b"two",
        "nothing is uploaded before the answer"
    );
    assert!(editor.answer(opened.edit_id, UserAnswer::Yes));
    wait_for(&events, |e| matches!(e, EditorEvent::Uploaded { .. })).await;
    assert_eq!(
        client.read(file.clone()).await.unwrap(),
        b"three, edited locally"
    );

    // clean up the remote scratch directory and end the session
    editor.end_session(id);
    ops::delete(&client, &dir).await.unwrap();
    started.session.close().await;
}

async fn wait_for(events: &Arc<Mutex<Vec<EditorEvent>>>, pred: impl Fn(&EditorEvent) -> bool) {
    let started = tokio::time::Instant::now();
    while !events.lock().unwrap().iter().any(&pred) {
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "timed out; events: {:?}",
            events.lock().unwrap()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
