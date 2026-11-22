// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! The external-editor round trip end to end: a real SSH transport, a real SFTP
//! server over a temporary directory, the real service, and a "user" that edits
//! the local copy by writing to it.

use super::policy::{RemoteWritePolicy, UserAnswer};
use super::service::{
    ConflictChoice, EditorError, EditorEvent, EditorService, Launcher, OpenParams, OpenedEdit,
    Timing,
};
use crate::lock::{Kdf, LockFlag, LockService};
use crate::security::secret::SecretString;
use crate::sessions::{SessionId, SessionRegistry};
use crate::sftp::{Client, SftpError, SftpState};
use crate::ssh::integration::{Env, Started, env, start_session_as, target, trust_and_password};
use crate::ssh::testserver::{Opts, TestServer};
use crate::ssh::testsftp::SftpOpts;
use crate::storage::connections::AuthMethod;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use uuid::Uuid;

const FAST: Timing = Timing {
    poll: Duration::from_millis(15),
    settle: Duration::from_millis(60),
    max_bytes: 64 * 1024 * 1024,
};

struct World {
    server: TestServer,
    env: Env,
    remote: tempfile::TempDir,
    local: tempfile::TempDir,
    registry: Arc<SessionRegistry>,
    lock: LockFlag,
    editor: EditorService,
    events: Arc<Mutex<Vec<EditorEvent>>>,
    launched: Arc<Mutex<Vec<PathBuf>>>,
}

fn build_editor(
    registry: &Arc<SessionRegistry>,
    lock: &LockFlag,
    timing: Timing,
) -> (EditorService, Arc<Mutex<Vec<EditorEvent>>>) {
    let events: Arc<Mutex<Vec<EditorEvent>>> = Arc::default();
    let sink = events.clone();
    let editor = EditorService::new(
        registry.clone(),
        lock.clone(),
        Arc::new(move |e| sink.lock().unwrap().push(e)),
        timing,
    );
    (editor, events)
}

async fn world_with(sftp: SftpOpts, timing: Timing) -> World {
    let remote = tempfile::tempdir().unwrap();
    let server = TestServer::start(Opts {
        users: vec![("tester".into(), "pw".into())],
        sftp_root: Some(remote.path().to_path_buf()),
        sftp: Arc::new(sftp),
        ..Default::default()
    })
    .await;
    let lock = LockFlag::default();
    let registry = Arc::new(SessionRegistry::with_lock(lock.clone()));
    let (editor, events) = build_editor(&registry, &lock, timing);
    World {
        server,
        env: env(trust_and_password("pw")),
        remote,
        local: tempfile::tempdir().unwrap(),
        registry,
        lock,
        editor,
        events,
        launched: Arc::default(),
    }
}

async fn world() -> World {
    world_with(
        SftpOpts {
            posix_rename: true,
            ..Default::default()
        },
        FAST,
    )
    .await
}

struct Conn {
    id: SessionId,
    started: Started,
    client: Arc<Client>,
}

impl World {
    /// A new SSH session with a registry-issued id, SFTP ready.
    async fn connect(&self) -> Conn {
        let id = self.registry.open(Uuid::new_v4()).unwrap();
        let started = start_session_as(
            &self.env,
            id,
            target(self.server.port, "tester", AuthMethod::Password),
            None,
        );
        started
            .sink
            .wait_until("sftp ready", |s| s.sftp_state() == Some(SftpState::Ready))
            .await;
        let client = started.session.sftp.client().unwrap();
        Conn {
            id,
            started,
            client,
        }
    }

    fn launcher(&self) -> Launcher {
        let launched = self.launched.clone();
        Arc::new(move |path: &Path| {
            launched.lock().unwrap().push(path.to_path_buf());
            Ok(())
        })
    }

    async fn open(&self, conn: &Conn, remote_path: &str) -> Result<OpenedEdit, EditorError> {
        self.open_with(&self.editor, conn, remote_path).await
    }

    async fn open_with(
        &self,
        editor: &EditorService,
        conn: &Conn,
        remote_path: &str,
    ) -> Result<OpenedEdit, EditorError> {
        editor
            .open_remote(OpenParams {
                session: conn.id,
                client: conn.client.clone(),
                remote_path: remote_path.to_owned(),
                temp_root: self.local.path().to_path_buf(),
                launch: self.launcher(),
            })
            .await
    }

    fn local_file(&self, opened: &OpenedEdit) -> PathBuf {
        self.local
            .path()
            .join(opened.edit_id.to_string())
            .join(&opened.name)
    }

    fn remote_file(&self, name: &str) -> PathBuf {
        self.remote.path().join(name)
    }

    fn count(&self, pred: impl Fn(&EditorEvent) -> bool) -> usize {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| pred(e))
            .count()
    }

    fn confirms(&self) -> usize {
        self.count(|e| matches!(e, EditorEvent::Confirm { .. }))
    }

    fn uploads(&self) -> usize {
        self.count(|e| matches!(e, EditorEvent::Uploaded { .. }))
    }

    async fn until(&self, what: &str, pred: impl Fn(&EditorEvent) -> bool + Copy) {
        let started = tokio::time::Instant::now();
        while self.count(pred) == 0 {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "timed out waiting for {what}; events: {:?}",
                self.events.lock().unwrap()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Wait until `n` events of a kind exist.
    async fn until_n(&self, what: &str, n: usize, pred: impl Fn(&EditorEvent) -> bool + Copy) {
        let started = tokio::time::Instant::now();
        while self.count(pred) < n {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "timed out waiting for {what} #{n}; events: {:?}",
                self.events.lock().unwrap()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

fn is_confirm(e: &EditorEvent) -> bool {
    matches!(e, EditorEvent::Confirm { .. })
}
fn is_uploaded(e: &EditorEvent) -> bool {
    matches!(e, EditorEvent::Uploaded { .. })
}
fn is_declined(e: &EditorEvent) -> bool {
    matches!(e, EditorEvent::Declined { .. })
}
fn is_conflict(e: &EditorEvent) -> bool {
    matches!(e, EditorEvent::Conflict { .. })
}
fn is_closed(e: &EditorEvent) -> bool {
    matches!(e, EditorEvent::Closed { .. })
}

/// What an editor does on save: write the new content (a tiny pause makes the
/// modification time differ even on coarse file systems).
async fn save(path: &Path, content: &[u8]) {
    tokio::time::sleep(Duration::from_millis(20)).await;
    std::fs::write(path, content).unwrap();
}

/// Let the watcher look at the file a few times.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(400)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn opening_downloads_to_a_private_copy_and_starts_the_editor() {
    let w = world().await;
    std::fs::create_dir(w.remote.path().join("etc")).unwrap();
    std::fs::write(w.remote_file("etc/app.conf"), b"port=22\n").unwrap();
    let conn = w.connect().await;
    let opened = w.open(&conn, "/etc/app.conf").await.unwrap();
    assert_eq!(opened.name, "app.conf");
    assert!(!opened.already_open);
    let local = w.local_file(&opened);
    assert_eq!(std::fs::read(&local).unwrap(), b"port=22\n");
    assert_eq!(*w.launched.lock().unwrap(), std::slice::from_ref(&local));
    assert!(local.starts_with(w.local.path()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&local).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    w.until("opened", |e| matches!(e, EditorEvent::Opened { .. }))
        .await;
    // nothing is uploaded or asked just because it was opened
    settle().await;
    assert_eq!((w.confirms(), w.uploads()), (0, 0));
    assert_eq!(
        std::fs::read(w.remote_file("etc/app.conf")).unwrap(),
        b"port=22\n"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn declining_leaves_the_remote_file_untouched_and_does_not_ask_again_for_the_same_content() {
    let w = world().await;
    std::fs::write(w.remote_file("a.txt"), b"original").unwrap();
    let conn = w.connect().await;
    let opened = w.open(&conn, "/a.txt").await.unwrap();
    let local = w.local_file(&opened);

    save(&local, b"my edit").await;
    w.until("prompt", is_confirm).await;
    assert!(w.editor.answer(opened.edit_id, UserAnswer::No));
    w.until("declined", is_declined).await;
    assert_eq!(std::fs::read(w.remote_file("a.txt")).unwrap(), b"original");

    // saving the same content again does not ask again
    save(&local, b"my edit").await;
    settle().await;
    assert_eq!(w.confirms(), 1);

    // but new content does
    save(&local, b"my second edit").await;
    w.until_n("second prompt", 2, is_confirm).await;
    assert!(w.editor.answer(opened.edit_id, UserAnswer::Cancel));
    w.until_n("declined twice", 2, is_declined).await;
    assert_eq!(std::fs::read(w.remote_file("a.txt")).unwrap(), b"original");
    assert_eq!(w.uploads(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn approving_uploads_the_edit_and_asks_again_next_time() {
    let w = world().await;
    std::fs::write(w.remote_file("a.txt"), b"original").unwrap();
    let conn = w.connect().await;
    let opened = w.open(&conn, "/a.txt").await.unwrap();
    let local = w.local_file(&opened);

    save(&local, b"edit one").await;
    w.until("prompt", is_confirm).await;
    assert!(w.editor.answer(opened.edit_id, UserAnswer::Yes));
    w.until("uploaded", is_uploaded).await;
    assert_eq!(std::fs::read(w.remote_file("a.txt")).unwrap(), b"edit one");
    assert!(
        w.events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, EditorEvent::Uploaded { atomic: true, .. }))
    );
    // no temporary files are left on the server
    let names: Vec<_> = std::fs::read_dir(w.remote.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["a.txt"]);

    // plain "Yes" does not switch anything on: the next save asks again
    save(&local, b"edit two").await;
    w.until_n("second prompt", 2, is_confirm).await;
    assert_eq!(std::fs::read(w.remote_file("a.txt")).unwrap(), b"edit one");
    assert_eq!(
        w.registry.write_policy(conn.id).unwrap(),
        RemoteWritePolicy::AlwaysAsk
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn saving_without_a_real_change_does_nothing() {
    let w = world().await;
    std::fs::write(w.remote_file("a.txt"), b"same").unwrap();
    let conn = w.connect().await;
    let opened = w.open(&conn, "/a.txt").await.unwrap();
    let local = w.local_file(&opened);
    save(&local, b"same").await; // new mtime, identical content
    save(&local, b"same").await;
    settle().await;
    assert_eq!((w.confirms(), w.uploads()), (0, 0));
    // an edit that is reverted before the editor settles is not a change either
    save(&local, b"temporary").await;
    save(&local, b"same").await;
    settle().await;
    assert_eq!(w.confirms(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_burst_of_saves_produces_one_prompt_for_the_final_content() {
    let w = world().await;
    std::fs::write(w.remote_file("a.txt"), b"v0").unwrap();
    let conn = w.connect().await;
    let opened = w.open(&conn, "/a.txt").await.unwrap();
    let local = w.local_file(&opened);
    for i in 1..=5 {
        std::fs::write(&local, format!("v{i} and more").as_bytes()).unwrap();
    }
    // A slow machine may let the watcher look in the middle of the burst; an
    // answer only ever covers the content it was asked about, so answer every
    // question until the final content is uploaded.
    let started = tokio::time::Instant::now();
    let mut answered = 0;
    while w.uploads() == 0 {
        assert!(started.elapsed() < Duration::from_secs(20), "no upload");
        if w.confirms() > answered {
            answered += 1;
            assert!(w.editor.answer(opened.edit_id, UserAnswer::Yes));
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        std::fs::read(w.remote_file("a.txt")).unwrap(),
        b"v5 and more",
        "the final content is what was uploaded"
    );
    settle().await;
    assert_eq!(w.confirms(), answered, "no further dialog after the upload");
}

#[tokio::test(flavor = "multi_thread")]
async fn editors_that_save_by_replacing_the_file_are_noticed() {
    let w = world().await;
    std::fs::write(w.remote_file("a.txt"), b"original").unwrap();
    let conn = w.connect().await;
    let opened = w.open(&conn, "/a.txt").await.unwrap();
    let local = w.local_file(&opened);
    // vim / Notepad++ style: write a sibling, then rename over the original
    let sibling = local.with_file_name("a.txt.swp-new");
    tokio::time::sleep(Duration::from_millis(20)).await;
    std::fs::write(&sibling, b"saved by atomic replace").unwrap();
    std::fs::rename(&sibling, &local).unwrap();
    w.until("prompt", is_confirm).await;
    assert!(w.editor.answer(opened.edit_id, UserAnswer::Yes));
    w.until("uploaded", is_uploaded).await;
    assert_eq!(
        std::fs::read(w.remote_file("a.txt")).unwrap(),
        b"saved by atomic replace"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_prompt_is_never_duplicated_and_an_answer_only_covers_what_was_shown() {
    let w = world().await;
    std::fs::write(w.remote_file("a.txt"), b"original").unwrap();
    let conn = w.connect().await;
    let opened = w.open(&conn, "/a.txt").await.unwrap();
    let local = w.local_file(&opened);

    save(&local, b"first version").await;
    w.until("prompt", is_confirm).await;
    // the user keeps typing while the dialog is open
    save(&local, b"second, longer version").await;
    settle().await;
    assert_eq!(w.confirms(), 1, "no second dialog while one is open");

    // "Yes" was given for the first version: the changed file must not be sent
    assert!(w.editor.answer(opened.edit_id, UserAnswer::Yes));
    w.until_n("prompt for the new content", 2, is_confirm).await;
    assert_eq!(w.uploads(), 0);
    assert_eq!(std::fs::read(w.remote_file("a.txt")).unwrap(), b"original");

    assert!(w.editor.answer(opened.edit_id, UserAnswer::Yes));
    w.until("uploaded", is_uploaded).await;
    assert_eq!(
        std::fs::read(w.remote_file("a.txt")).unwrap(),
        b"second, longer version"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn answers_that_do_not_belong_to_an_open_prompt_are_ignored() {
    let w = world().await;
    std::fs::write(w.remote_file("a.txt"), b"original").unwrap();
    let conn = w.connect().await;
    let opened = w.open(&conn, "/a.txt").await.unwrap();
    let local = w.local_file(&opened);

    // pre-emptive "Yes to all" before anything was asked
    assert!(!w.editor.answer(opened.edit_id, UserAnswer::YesToAll));
    assert!(!w.editor.answer(Uuid::new_v4(), UserAnswer::YesToAll));
    assert!(
        !w.editor
            .resolve_conflict(opened.edit_id, ConflictChoice::Overwrite)
    );
    assert!(!w.editor.retry(opened.edit_id));
    assert_eq!(
        w.registry.write_policy(conn.id).unwrap(),
        RemoteWritePolicy::AlwaysAsk
    );

    save(&local, b"edit").await;
    w.until("prompt", is_confirm).await;
    assert_eq!(w.uploads(), 0, "still asked");
    assert!(w.editor.answer(opened.edit_id, UserAnswer::No));
    assert!(
        !w.editor.answer(opened.edit_id, UserAnswer::Yes),
        "an answer is single-use"
    );
    settle().await;
    assert_eq!(w.uploads(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_changed_on_the_server_is_a_conflict_not_an_overwrite() {
    let w = world().await;
    std::fs::write(w.remote_file("a.txt"), b"original").unwrap();
    let conn = w.connect().await;
    let opened = w.open(&conn, "/a.txt").await.unwrap();
    let local = w.local_file(&opened);

    // somebody else edits the file on the server
    std::fs::write(w.remote_file("a.txt"), b"changed by a colleague").unwrap();
    save(&local, b"my edit").await;
    w.until("prompt", is_confirm).await;
    assert!(w.editor.answer(opened.edit_id, UserAnswer::Yes));
    w.until("conflict", is_conflict).await;
    assert_eq!(w.uploads(), 0);
    assert_eq!(
        std::fs::read(w.remote_file("a.txt")).unwrap(),
        b"changed by a colleague",
        "the colleague's change is intact"
    );
    assert_eq!(std::fs::read(&local).unwrap(), b"my edit");

    // keep local: the server stays as it is and the same content is not re-sent
    assert!(
        w.editor
            .resolve_conflict(opened.edit_id, ConflictChoice::KeepLocal)
    );
    w.until("declined", is_declined).await;
    settle().await;
    assert_eq!((w.uploads(), w.confirms()), (0, 1));

    // a further edit asks again, conflicts again, and this time I overwrite
    save(&local, b"my edit, take two").await;
    w.until_n("prompt", 2, is_confirm).await;
    assert!(w.editor.answer(opened.edit_id, UserAnswer::Yes));
    w.until_n("conflict again", 2, is_conflict).await;
    assert!(
        w.editor
            .resolve_conflict(opened.edit_id, ConflictChoice::Overwrite)
    );
    w.until("uploaded", is_uploaded).await;
    assert_eq!(
        std::fs::read(w.remote_file("a.txt")).unwrap(),
        b"my edit, take two"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn conflicts_are_detected_even_when_yes_to_all_is_active() {
    let w = world().await;
    std::fs::write(w.remote_file("a.txt"), b"original").unwrap();
    let conn = w.connect().await;
    let opened = w.open(&conn, "/a.txt").await.unwrap();
    let local = w.local_file(&opened);
    save(&local, b"first").await;
    w.until("prompt", is_confirm).await;
    assert!(w.editor.answer(opened.edit_id, UserAnswer::YesToAll));
    w.until("uploaded", is_uploaded).await;

    std::fs::write(w.remote_file("a.txt"), b"someone else, later").unwrap();
    save(&local, b"second").await;
    w.until("conflict", is_conflict).await;
    assert_eq!(
        std::fs::read(w.remote_file("a.txt")).unwrap(),
        b"someone else, later"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_upload_keeps_the_local_copy_and_can_be_retried() {
    let w = world_with(
        SftpOpts {
            posix_rename: true,
            fail_write_after: Some(2048),
            ..Default::default()
        },
        FAST,
    )
    .await;
    std::fs::write(w.remote_file("a.txt"), b"original").unwrap();
    let conn = w.connect().await;
    let opened = w.open(&conn, "/a.txt").await.unwrap();
    let local = w.local_file(&opened);
    let big = vec![b'x'; 200 * 1024];
    save(&local, &big).await;
    w.until("prompt", is_confirm).await;
    assert!(w.editor.answer(opened.edit_id, UserAnswer::Yes));
    w.until("failure", |e| matches!(e, EditorEvent::UploadFailed { .. }))
        .await;
    assert_eq!(
        std::fs::read(&local).unwrap(),
        big,
        "local changes preserved"
    );
    assert_eq!(std::fs::read(w.remote_file("a.txt")).unwrap(), b"original");
    assert_eq!(
        std::fs::read_dir(w.remote.path()).unwrap().count(),
        1,
        "no partial file on the server"
    );
    // the same content is not retried by itself...
    settle().await;
    assert_eq!(
        w.count(|e| matches!(e, EditorEvent::UploadFailed { .. })),
        1
    );
    // ...but the user can retry (asked again: the policy is still AlwaysAsk)
    assert!(w.editor.retry(opened.edit_id));
    w.until_n("prompt again", 2, is_confirm).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn opening_the_same_file_twice_reuses_one_copy() {
    let w = world().await;
    std::fs::write(w.remote_file("a.txt"), b"x").unwrap();
    let conn = w.connect().await;
    let first = w.open(&conn, "/a.txt").await.unwrap();
    let second = w.open(&conn, "/./a.txt").await.unwrap();
    assert!(second.already_open);
    assert_eq!(first.edit_id, second.edit_id);
    assert_eq!(w.launched.lock().unwrap().len(), 2, "editor started again");
    assert_eq!(w.editor.count(conn.id), 1);

    // a different session gets its own copy (and its own policy)
    let other = w.connect().await;
    let third = w.open(&other, "/a.txt").await.unwrap();
    assert_ne!(third.edit_id, first.edit_id);
}

#[tokio::test(flavor = "multi_thread")]
async fn directories_missing_files_and_big_files_are_refused() {
    let w = world_with(
        SftpOpts::default(),
        Timing {
            max_bytes: 100,
            ..FAST
        },
    )
    .await;
    std::fs::create_dir(w.remote_file("dir")).unwrap();
    std::fs::write(w.remote_file("big.bin"), vec![0u8; 500]).unwrap();
    std::fs::write(w.remote_file("ok.txt"), b"fine").unwrap();
    let conn = w.connect().await;
    assert_eq!(
        w.open(&conn, "/dir").await.unwrap_err(),
        EditorError::Remote(SftpError::IsADirectory)
    );
    assert_eq!(
        w.open(&conn, "/big.bin").await.unwrap_err(),
        EditorError::TooLarge
    );
    assert_eq!(
        w.open(&conn, "/missing").await.unwrap_err(),
        EditorError::Remote(SftpError::NotFound)
    );
    assert_eq!(
        w.open(&conn, "").await.unwrap_err(),
        EditorError::Remote(SftpError::InvalidPath)
    );
    assert!(w.open(&conn, "/ok.txt").await.is_ok());
    // nothing was created for the refused ones
    assert_eq!(std::fs::read_dir(w.local.path()).unwrap().count(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_launch_failure_is_reported_and_leaves_no_files_behind() {
    let w = world().await;
    std::fs::write(w.remote_file("a.txt"), b"x").unwrap();
    let conn = w.connect().await;
    let result = w
        .editor
        .open_remote(OpenParams {
            session: conn.id,
            client: conn.client.clone(),
            remote_path: "/a.txt".into(),
            temp_root: w.local.path().to_path_buf(),
            launch: Arc::new(|_| Err(())),
        })
        .await;
    assert_eq!(result.unwrap_err(), EditorError::LaunchFailed);
    assert_eq!(std::fs::read_dir(w.local.path()).unwrap().count(), 0);
    assert_eq!(w.editor.count(conn.id), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn hostile_remote_names_cannot_escape_the_managed_directory() {
    let w = world().await;
    std::fs::write(w.remote_file("a:b*c?.txt"), b"x").unwrap_or(());
    std::fs::write(w.remote_file("normal.txt"), b"x").unwrap();
    let conn = w.connect().await;
    // ".." segments are resolved by the server inside its root; the local name is
    // only ever the sanitised last component
    let opened = w.open(&conn, "/../../normal.txt").await.unwrap();
    let local = w.local_file(&opened);
    assert!(local.starts_with(w.local.path()));
    assert_eq!(local.parent().unwrap().parent().unwrap(), w.local.path());
    assert_eq!(opened.name, "normal.txt");
}

#[tokio::test(flavor = "multi_thread")]
async fn ending_the_session_cleans_up_but_never_discards_unsent_changes() {
    let w = world().await;
    std::fs::write(w.remote_file("clean.txt"), b"1").unwrap();
    std::fs::write(w.remote_file("dirty.txt"), b"2").unwrap();
    let conn = w.connect().await;
    let clean = w.open(&conn, "/clean.txt").await.unwrap();
    let dirty = w.open(&conn, "/dirty.txt").await.unwrap();
    save(&w.local_file(&dirty), b"unsent work").await;
    w.until("prompt", is_confirm).await;

    w.editor.end_session(conn.id);
    w.until_n("both closed", 2, is_closed).await;
    assert!(
        !w.local_file(&clean).exists(),
        "an unchanged copy is removed"
    );
    assert_eq!(
        std::fs::read(w.local_file(&dirty)).unwrap(),
        b"unsent work",
        "unsent changes are kept"
    );
    assert!(w.events.lock().unwrap().iter().any(|e| matches!(
        e,
        EditorEvent::Closed { kept_local: true, name, .. } if name == "dirty.txt"
    )));
    assert_eq!(w.editor.count(conn.id), 0);
    assert_eq!(std::fs::read(w.remote_file("dirty.txt")).unwrap(), b"2");
}

#[tokio::test(flavor = "multi_thread")]
async fn nothing_is_asked_or_sent_while_the_application_is_locked() {
    let dir = tempfile::tempdir().unwrap();
    let lock_service = LockService::open(dir.path().join("lock.json"), Kdf::FAST);
    lock_service
        .set_password(&SecretString::new("correct horse".into()), None)
        .unwrap();
    lock_service.configure(true, 0, false);

    let w = world().await;
    // rebuild the service around the real lock flag
    let registry = Arc::new(SessionRegistry::with_lock(lock_service.flag()));
    let (editor, events) = build_editor(&registry, &lock_service.flag(), FAST);
    let w = World {
        registry,
        lock: lock_service.flag(),
        editor,
        events,
        ..w
    };
    std::fs::write(w.remote_file("a.txt"), b"original").unwrap();
    let conn = w.connect().await;
    let opened = w.open(&conn, "/a.txt").await.unwrap();
    let local = w.local_file(&opened);

    lock_service.lock().unwrap();
    assert!(w.lock.is_locked());
    save(&local, b"edited while locked").await;
    settle().await;
    assert_eq!(w.confirms(), 0, "no prompt while locked");
    assert!(!w.editor.answer(opened.edit_id, UserAnswer::Yes), "locked");

    lock_service
        .unlock(&SecretString::new("correct horse".into()))
        .unwrap();
    w.until("prompt after unlock", is_confirm).await;
    assert_eq!(std::fs::read(w.remote_file("a.txt")).unwrap(), b"original");
}

/// THE security regression. Steps from the milestone specification:
/// connect to A → edit X → "Yes to all" → later edits upload without prompts in
/// that connection → disconnect → reconnect → edit → confirmation required →
/// restart the application → reconnect → confirmation still required.
#[tokio::test(flavor = "multi_thread")]
async fn yes_to_all_lives_and_dies_with_one_ssh_session() {
    let w = world().await;
    std::fs::write(w.remote_file("x.conf"), b"v0").unwrap();

    // 1-2. connect to A, open X, edit
    let conn_a = w.connect().await;
    let edit = w.open(&conn_a, "/x.conf").await.unwrap();
    let local = w.local_file(&edit);
    save(&local, b"v1").await;
    w.until("first prompt", is_confirm).await;
    assert_eq!(std::fs::read(w.remote_file("x.conf")).unwrap(), b"v0");

    // 3. "Yes to all"
    assert!(w.editor.answer(edit.edit_id, UserAnswer::YesToAll));
    w.until("first upload", is_uploaded).await;
    assert_eq!(std::fs::read(w.remote_file("x.conf")).unwrap(), b"v1");
    assert_eq!(
        w.registry.write_policy(conn_a.id).unwrap(),
        RemoteWritePolicy::AutoUploadThisSession
    );

    // 4. further edits in the SAME connection upload without any prompt
    save(&local, b"v2").await;
    w.until_n("second upload", 2, is_uploaded).await;
    save(&local, b"v3").await;
    w.until_n("third upload", 3, is_uploaded).await;
    assert_eq!(std::fs::read(w.remote_file("x.conf")).unwrap(), b"v3");
    assert_eq!(
        w.confirms(),
        1,
        "only the very first edit was ever asked about"
    );

    // 5. disconnect (what `ssh.rs`'s on_end does)
    conn_a.started.session.close().await;
    conn_a
        .started
        .sink
        .wait_until("closed", |s| s.closed_reason().is_some())
        .await;
    w.editor.end_session(conn_a.id);
    w.registry.close(conn_a.id).unwrap();
    w.until("edit closed", is_closed).await;
    assert!(
        w.registry.write_policy(conn_a.id).is_err(),
        "old session is gone"
    );

    // 6. reconnect to the same server: a NEW session, AlwaysAsk again
    let conn_b = w.connect().await;
    assert_ne!(conn_a.id, conn_b.id);
    assert_eq!(
        w.registry.write_policy(conn_b.id).unwrap(),
        RemoteWritePolicy::AlwaysAsk
    );
    let edit_b = w.open(&conn_b, "/x.conf").await.unwrap();
    let local_b = w.local_file(&edit_b);
    let asked_before = w.confirms();
    save(&local_b, b"v4").await;
    w.until_n("prompt after reconnect", asked_before + 1, is_confirm)
        .await;
    settle().await;
    assert_eq!(
        std::fs::read(w.remote_file("x.conf")).unwrap(),
        b"v3",
        "nothing uploaded without a new confirmation after reconnecting"
    );
    assert_eq!(w.uploads(), 3);

    // 7-8. restart the application: nothing survives, a brand new registry and
    // service start with the default policy
    let lock = LockFlag::default();
    let registry = Arc::new(SessionRegistry::with_lock(lock.clone()));
    let (editor, events) = build_editor(&registry, &lock, FAST);
    let restarted = World {
        registry,
        lock,
        editor,
        events,
        launched: Arc::default(),
        local: tempfile::tempdir().unwrap(),
        ..w
    };
    let conn_c = restarted.connect().await;
    assert_eq!(
        restarted.registry.write_policy(conn_c.id).unwrap(),
        RemoteWritePolicy::AlwaysAsk
    );
    let edit_c = restarted.open(&conn_c, "/x.conf").await.unwrap();
    save(&restarted.local_file(&edit_c), b"v5 after restart").await;
    restarted.until("prompt after restart", is_confirm).await;
    settle().await;
    assert_eq!(restarted.uploads(), 0);
    assert_eq!(
        std::fs::read(restarted.remote_file("x.conf")).unwrap(),
        b"v3"
    );
}

/// "Yes to all" in one connection must not leak to a parallel connection of
/// the same server.
#[tokio::test(flavor = "multi_thread")]
async fn yes_to_all_does_not_leak_to_a_parallel_connection() {
    let w = world().await;
    std::fs::write(w.remote_file("a.txt"), b"0").unwrap();
    std::fs::write(w.remote_file("b.txt"), b"0").unwrap();
    let one = w.connect().await;
    let two = w.connect().await;
    let edit_one = w.open(&one, "/a.txt").await.unwrap();
    let edit_two = w.open(&two, "/b.txt").await.unwrap();
    save(&w.local_file(&edit_one), b"1").await;
    w.until("prompt", is_confirm).await;
    assert!(w.editor.answer(edit_one.edit_id, UserAnswer::YesToAll));
    w.until("uploaded", is_uploaded).await;

    save(&w.local_file(&edit_two), b"2").await;
    w.until_n("second connection asks", 2, is_confirm).await;
    settle().await;
    assert_eq!(std::fs::read(w.remote_file("b.txt")).unwrap(), b"0");
}

/// Locking the application forgets "Yes to all" (see `lib.rs`).
#[tokio::test(flavor = "multi_thread")]
async fn locking_the_application_forgets_yes_to_all() {
    let w = world().await;
    std::fs::write(w.remote_file("a.txt"), b"0").unwrap();
    let conn = w.connect().await;
    let edit = w.open(&conn, "/a.txt").await.unwrap();
    let local = w.local_file(&edit);
    save(&local, b"1").await;
    w.until("prompt", is_confirm).await;
    assert!(w.editor.answer(edit.edit_id, UserAnswer::YesToAll));
    w.until("uploaded", is_uploaded).await;

    w.registry.reset_write_policies().unwrap(); // what the lock notifier does
    save(&local, b"2").await;
    w.until_n("asked again", 2, is_confirm).await;
    assert_eq!(std::fs::read(w.remote_file("a.txt")).unwrap(), b"1");
}

/// Static guard: the only code that can write a remote file is the safe-write
/// function, called from the user-initiated transfer module and from the
/// editor's `Edit::upload`, which takes an `UploadAuthorization` by value.
#[test]
fn the_only_write_paths_are_the_reviewed_ones() {
    fn scan(dir: &Path, hits: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                scan(&path, hits);
            } else if path.extension().is_some_and(|e| e == "rs")
                && !path.file_name().is_some_and(|n| {
                    n.to_string_lossy().contains("test")
                        || n == "integration.rs"
                        || n == "openssh_ci.rs"
                })
            {
                let text = std::fs::read_to_string(&path).unwrap();
                // test code is allowed to exercise the function
                let production = text.split("#[cfg(test)]").next().unwrap_or("");
                if production.contains("put_file(") {
                    let rel = path
                        .strip_prefix(env!("CARGO_MANIFEST_DIR"))
                        .unwrap()
                        .to_string_lossy()
                        .replace(std::path::MAIN_SEPARATOR, "/");
                    hits.push(rel);
                }
            }
        }
    }
    let mut hits = Vec::new();
    scan(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut hits,
    );
    hits.sort();
    assert_eq!(
        hits,
        ["src/editor/service.rs", "src/sftp/transfer.rs"],
        "a new writer of remote files must be reviewed against the confirmation policy"
    );

    let service = include_str!("service.rs");
    assert_eq!(service.matches("put_file(").count(), 1);
    assert!(service.contains("auth: UploadAuthorization"));
    assert!(service.contains("async fn upload("));
    // an authorization can only be minted inside the policy module
    let policy = include_str!("policy.rs");
    assert!(policy.contains("fn for_request("));
    assert!(!policy.contains("pub fn for_request("));
}
