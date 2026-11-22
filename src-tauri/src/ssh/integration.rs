//! Integration tests: the real client against an in-process SSH server.

use super::client::{Deps, SshError, Target, connect};
use super::prompt::{Answer, HostKeyDecision, PromptEvent, Prompts};
use super::session::{self, Sink, StartParams, decode};
use super::testserver::{Opts, TestServer, random_key};
use super::{SessionState, TerminalEvent};
use crate::security::credentials::{CredentialStore, MemoryCredentialStore};
use crate::security::known_hosts::KnownHostsStore;
use crate::security::secret::SecretString;
use crate::sessions::SessionId;
use crate::storage::connections::AuthMethod;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use uuid::Uuid;

pub type Policy = Arc<dyn Fn(&PromptEvent) -> Answer + Send + Sync>;

pub struct Env {
    pub dir: tempfile::TempDir,
    pub known_hosts: Arc<KnownHostsStore>,
    pub credentials: Arc<MemoryCredentialStore>,
    pub prompts: Prompts,
    pub events: Arc<Mutex<Vec<PromptEvent>>>,
}

/// Answers every prompt with `policy` (as the UI would).
pub fn env(policy: Policy) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let known_hosts = Arc::new(KnownHostsStore::open(dir.path().join("known_hosts.json")).unwrap());
    let (tx, mut rx) = mpsc::unbounded_channel::<PromptEvent>();
    let prompts = Prompts::new(Arc::new(move |e| {
        let _ = tx.send(e);
    }));
    let events = Arc::new(Mutex::new(Vec::new()));
    let (p, ev) = (prompts.clone(), events.clone());
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let id = match &event {
                PromptEvent::HostKey { prompt_id, .. } | PromptEvent::Auth { prompt_id, .. } => {
                    *prompt_id
                }
            };
            let answer = policy(&event);
            ev.lock().unwrap().push(event);
            p.answer(id, answer);
        }
    });
    Env {
        dir,
        known_hosts,
        credentials: Arc::new(MemoryCredentialStore::new()),
        prompts,
        events,
    }
}

pub fn secrets(values: &[&str]) -> Answer {
    Answer::Secrets(Some(
        values
            .iter()
            .map(|v| SecretString::new((*v).to_owned()))
            .collect(),
    ))
}

pub fn trust_and_password(pw: &'static str) -> Policy {
    Arc::new(move |e| match e {
        PromptEvent::HostKey { .. } => Answer::HostKey(HostKeyDecision::TrustAndSave),
        PromptEvent::Auth { .. } => secrets(&[pw]),
    })
}

impl Env {
    pub fn deps(&self) -> Deps {
        Deps {
            known_hosts: self.known_hosts.clone(),
            credentials: self.credentials.clone() as Arc<dyn CredentialStore>,
            prompts: self.prompts.clone(),
            session: Uuid::new_v4(),
        }
    }
    pub fn host_key_prompts(&self) -> usize {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, PromptEvent::HostKey { .. }))
            .count()
    }
    pub fn auth_prompts(&self) -> usize {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, PromptEvent::Auth { .. }))
            .count()
    }
}

pub fn target(port: u16, user: &str, auth: AuthMethod) -> Target {
    Target {
        host: "127.0.0.1".into(),
        port,
        username: user.into(),
        auth,
        key_path: None,
        connect_timeout: Duration::from_secs(10),
        keepalive: None,
        secret_account: None,
    }
}

fn password_server(user: &str, pw: &str) -> Opts {
    Opts {
        users: vec![(user.into(), pw.into())],
        ..Default::default()
    }
}

#[derive(Default)]
pub struct VecSink {
    pub events: Mutex<Vec<TerminalEvent>>,
    pub notify: tokio::sync::Notify,
}
impl Sink for VecSink {
    fn send(&self, event: TerminalEvent) {
        self.events.lock().unwrap().push(event);
        self.notify.notify_waiters();
    }
}
impl VecSink {
    pub fn text(&self) -> String {
        let mut out = Vec::new();
        for e in self.events.lock().unwrap().iter() {
            if let TerminalEvent::Data { data } = e {
                out.extend(decode(data).unwrap());
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }
    pub fn states(&self) -> Vec<SessionState> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| {
                if let TerminalEvent::Status { state } = e {
                    Some(*state)
                } else {
                    None
                }
            })
            .collect()
    }
    pub fn closed_reason(&self) -> Option<Option<String>> {
        self.events.lock().unwrap().iter().find_map(|e| {
            if let TerminalEvent::Closed { reason } = e {
                Some(reason.clone())
            } else {
                None
            }
        })
    }
    pub async fn wait_until(&self, what: &str, mut ok: impl FnMut(&VecSink) -> bool) {
        let started = tokio::time::Instant::now();
        while !ok(self) {
            assert!(
                started.elapsed() < Duration::from_secs(15),
                "timed out waiting for {what}"
            );
            let _ = tokio::time::timeout(Duration::from_millis(50), self.notify.notified()).await;
        }
    }
}

pub struct Started {
    pub session: Arc<session::SshSession>,
    pub sink: Arc<VecSink>,
    pub ended: Arc<Mutex<Vec<SessionId>>>,
}

pub fn start_session(env: &Env, target: Target, initial_dir: Option<&str>) -> Started {
    let sink = Arc::new(VecSink::default());
    let ended = Arc::new(Mutex::new(Vec::new()));
    let id = SessionId::new();
    let mut deps = env.deps();
    deps.session = id.uuid();
    let e = ended.clone();
    let session = session::start(StartParams {
        id,
        connection_id: Uuid::new_v4(),
        target,
        deps,
        cols: 100,
        rows: 30,
        initial_directory: initial_dir.map(str::to_owned),
        sink: sink.clone(),
        on_end: Arc::new(move |i| e.lock().unwrap().push(i)),
    });
    Started {
        session,
        sink,
        ended,
    }
}

// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn password_login_runs_an_interactive_shell_with_pty_and_resize() {
    let server = TestServer::start(password_server("tester", "s3cret")).await;
    let env = env(trust_and_password("s3cret"));
    let s = start_session(
        &env,
        target(server.port, "tester", AuthMethod::Password),
        None,
    );
    s.sink
        .wait_until("banner", |k| k.text().contains("ready"))
        .await;
    assert_eq!(
        s.sink.states()[..2],
        [SessionState::Connecting, SessionState::Connected]
    );
    assert_eq!(
        server.rec.ptys.lock().unwrap()[0],
        ("xterm-256color".to_owned(), 100, 30)
    );

    // input round trip, UTF-8 intact
    assert!(s.session.write("héllo ✓\n".as_bytes().to_vec()).await);
    s.sink
        .wait_until("echo", |k| k.text().contains("héllo ✓"))
        .await;
    // resize reaches the server
    assert!(s.session.resize(132, 43).await);
    for _ in 0..100 {
        if !server.rec.resizes.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(server.rec.resizes.lock().unwrap()[0], (132, 43));

    s.session.close().await;
    s.sink
        .wait_until("closed", |k| k.closed_reason().is_some())
        .await;
    assert_eq!(
        s.sink.closed_reason(),
        Some(None),
        "a normal close has no failure reason"
    );
    assert_eq!(s.sink.states().last(), Some(&SessionState::Disconnected));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        s.ended.lock().unwrap().len(),
        1,
        "on_end called exactly once"
    );
    assert_eq!(env.prompts.pending_count(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn wrong_passwords_are_rejected_after_three_tries_and_never_logged_in() {
    let server = TestServer::start(password_server("tester", "s3cret")).await;
    let env = env(trust_and_password("nope"));
    let err = connect(
        &target(server.port, "tester", AuthMethod::Password),
        &env.deps(),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(err, SshError::AuthFailed);
    assert_eq!(env.auth_prompts(), 3);
    assert_eq!(server.rec.shells.load(Ordering::SeqCst), 0);
    // the retry flag is set after the first failure
    let events = env.events.lock().unwrap();
    let retries: Vec<bool> = events
        .iter()
        .filter_map(|e| {
            if let PromptEvent::Auth { retry, .. } = e {
                Some(*retry)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(retries, [false, true, true]);
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_the_password_prompt_stops_cleanly() {
    let server = TestServer::start(password_server("tester", "s3cret")).await;
    let env = env(Arc::new(|e| match e {
        PromptEvent::HostKey { .. } => Answer::HostKey(HostKeyDecision::TrustOnce),
        PromptEvent::Auth { .. } => Answer::Secrets(None),
    }));
    let err = connect(
        &target(server.port, "tester", AuthMethod::Password),
        &env.deps(),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(err, SshError::Cancelled);
}

#[tokio::test(flavor = "multi_thread")]
async fn saved_password_is_used_first_without_prompting() {
    let server = TestServer::start(password_server("tester", "s3cret")).await;
    let env = env(Arc::new(|e| match e {
        PromptEvent::HostKey { .. } => Answer::HostKey(HostKeyDecision::TrustOnce),
        PromptEvent::Auth { .. } => panic!("the saved password must be tried first"),
    }));
    env.credentials
        .set("acct", &SecretString::new("s3cret".into()))
        .unwrap();
    let mut t = target(server.port, "tester", AuthMethod::Password);
    t.secret_account = Some("acct".into());
    let ok = connect(&t, &env.deps()).await;
    assert!(ok.is_ok());
    assert_eq!(ok.ok().unwrap().auth_kind, "password");
}

#[tokio::test(flavor = "multi_thread")]
async fn public_key_login_and_wrong_key_rejection() {
    let client_key = random_key();
    let server = TestServer::start(Opts {
        keys: vec![client_key.public_key().clone()],
        ..Default::default()
    })
    .await;
    let env = env(trust_and_password("unused"));
    let key_file = env.dir.path().join("id_ed25519");
    client_key
        .write_openssh_file(&key_file, russh::keys::ssh_key::LineEnding::LF)
        .unwrap();
    let mut t = target(server.port, "tester", AuthMethod::PublicKey);
    t.key_path = Some(key_file.to_string_lossy().into_owned());
    let connected = connect(&t, &env.deps()).await.ok().unwrap();
    assert_eq!(connected.auth_kind, "public_key");

    // a key the server does not know
    let other = env.dir.path().join("other");
    random_key()
        .write_openssh_file(&other, russh::keys::ssh_key::LineEnding::LF)
        .unwrap();
    t.key_path = Some(other.to_string_lossy().into_owned());
    assert_eq!(
        connect(&t, &env.deps()).await.err().unwrap(),
        SshError::AuthFailed
    );
    // a missing key file is reported as such, without any prompt for a password
    t.key_path = Some(
        env.dir
            .path()
            .join("missing")
            .to_string_lossy()
            .into_owned(),
    );
    assert_eq!(
        connect(&t, &env.deps()).await.err().unwrap(),
        SshError::KeyUnreadable
    );
}

fn make_encrypted_key(
    dir: &std::path::Path,
    pass: &str,
) -> Option<(std::path::PathBuf, russh::keys::PublicKey)> {
    let path = dir.join("enc_key");
    let status = std::process::Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", pass, "-C", "", "-f"])
        .arg(&path)
        .status()
        .ok()?;
    status.success().then_some(())?;
    let public = russh::keys::PublicKey::read_openssh_file(path.with_extension("pub")).ok()?;
    Some((path, public))
}

#[tokio::test(flavor = "multi_thread")]
async fn encrypted_private_key_asks_for_the_passphrase() {
    let dir = tempfile::tempdir().unwrap();
    let Some((key_path, public)) = make_encrypted_key(dir.path(), "open sesame") else {
        eprintln!("ssh-keygen not available; skipping");
        return;
    };
    let server = TestServer::start(Opts {
        keys: vec![public],
        ..Default::default()
    })
    .await;
    let env = env(Arc::new(|e| match e {
        PromptEvent::HostKey { .. } => Answer::HostKey(HostKeyDecision::TrustOnce),
        PromptEvent::Auth { method, retry, .. } => {
            assert_eq!(*method, "passphrase");
            secrets(&[if *retry { "open sesame" } else { "wrong" }])
        }
    }));
    let mut t = target(server.port, "tester", AuthMethod::PublicKey);
    t.key_path = Some(key_path.to_string_lossy().into_owned());
    let c = connect(&t, &env.deps()).await.ok().unwrap();
    assert_eq!(c.auth_kind, "public_key");
    assert_eq!(
        env.auth_prompts(),
        2,
        "first (wrong) passphrase retried once"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn keyboard_interactive_prompts_are_shown_and_answered() {
    let server = TestServer::start(Opts {
        kbd: Some((
            "tester".into(),
            vec![
                ("Code: ".into(), "123456".into()),
                ("Pet: ".into(), "cat".into()),
            ],
        )),
        ..Default::default()
    })
    .await;
    let env = env(Arc::new(|e| match e {
        PromptEvent::HostKey { .. } => Answer::HostKey(HostKeyDecision::TrustOnce),
        PromptEvent::Auth {
            method, prompts, ..
        } => {
            assert_eq!(*method, "keyboardInteractive");
            assert_eq!(prompts.len(), 2);
            assert_eq!(prompts[0].text, "Code: ");
            secrets(&["123456", "cat"])
        }
    }));
    let c = connect(
        &target(server.port, "tester", AuthMethod::KeyboardInteractive),
        &env.deps(),
    )
    .await;
    assert_eq!(c.ok().unwrap().auth_kind, "keyboard_interactive");

    let env2 = env_with_answers(&["000000", "dog"]);
    let err = connect(
        &target(server.port, "tester", AuthMethod::KeyboardInteractive),
        &env2.deps(),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(err, SshError::AuthFailed);
}

fn env_with_answers(answers: &'static [&'static str]) -> Env {
    env(Arc::new(move |e| match e {
        PromptEvent::HostKey { .. } => Answer::HostKey(HostKeyDecision::TrustOnce),
        PromptEvent::Auth { .. } => secrets(answers),
    }))
}

// --- host keys -------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn unknown_host_key_asks_once_and_trust_is_remembered() {
    let server = TestServer::start(password_server("tester", "pw")).await;
    let env = env(trust_and_password("pw"));
    let t = target(server.port, "tester", AuthMethod::Password);
    let first = connect(&t, &env.deps()).await.ok().unwrap();
    assert_eq!(first.host_key, Some(super::client::HostKeyOutcome::Saved));
    assert_eq!(env.host_key_prompts(), 1);
    let stored = env.known_hosts.list().unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(
        stored[0].fingerprint,
        super::fingerprint_sha256(&server.host_public)
    );
    // second connection: no question
    let second = connect(&t, &env.deps()).await.ok().unwrap();
    assert_eq!(
        second.host_key,
        Some(super::client::HostKeyOutcome::Matched)
    );
    assert_eq!(env.host_key_prompts(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn rejecting_the_host_key_stops_before_any_credential_is_sent() {
    let server = TestServer::start(password_server("tester", "pw")).await;
    let env = env(Arc::new(|e| match e {
        PromptEvent::HostKey { .. } => Answer::HostKey(HostKeyDecision::Reject),
        PromptEvent::Auth { .. } => {
            panic!("no credential prompt may appear before the key is trusted")
        }
    }));
    let err = connect(
        &target(server.port, "tester", AuthMethod::Password),
        &env.deps(),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(err, SshError::HostKeyRejected);
    assert_eq!(
        server.rec.auth_attempts.load(Ordering::SeqCst),
        0,
        "the server never saw an auth attempt"
    );
    assert!(env.known_hosts.list().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn trust_once_does_not_persist() {
    let server = TestServer::start(password_server("tester", "pw")).await;
    let env = env(Arc::new(|e| match e {
        PromptEvent::HostKey { .. } => Answer::HostKey(HostKeyDecision::TrustOnce),
        PromptEvent::Auth { .. } => secrets(&["pw"]),
    }));
    let t = target(server.port, "tester", AuthMethod::Password);
    assert!(connect(&t, &env.deps()).await.is_ok());
    assert!(env.known_hosts.list().unwrap().is_empty());
    assert!(connect(&t, &env.deps()).await.is_ok());
    assert_eq!(
        env.host_key_prompts(),
        2,
        "asked again because nothing was stored"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_changed_host_key_is_never_accepted_silently_or_by_a_plain_trust_answer() {
    let server = TestServer::start(password_server("tester", "pw")).await;
    let env = env(trust_and_password("pw"));
    // The store believes this host/port has another key.
    env.known_hosts
        .trust(
            "127.0.0.1",
            server.port,
            "ssh-ed25519",
            "SHA256:OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD",
            false,
        )
        .unwrap();
    let t = target(server.port, "tester", AuthMethod::Password);

    // "Trust and save" / "trust once" on a CHANGED key are treated as rejection.
    let err = connect(&t, &env.deps()).await.err().unwrap();
    assert_eq!(err, SshError::HostKeyRejected);
    let first = env.events.lock().unwrap().remove(0);
    match &first {
        PromptEvent::HostKey {
            previous_fingerprint,
            ..
        } => {
            assert_eq!(
                previous_fingerprint.as_deref(),
                Some("SHA256:OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD")
            );
        }
        other => panic!("expected a host-key prompt, got {other:?}"),
    }
    assert_eq!(
        env.known_hosts.list().unwrap()[0].fingerprint,
        "SHA256:OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD"
    );
    assert_eq!(server.rec.auth_attempts.load(Ordering::SeqCst), 0);

    // Only an explicit Replace updates the stored key.
    let replace = env_replace(&env);
    let ok = connect(&t, &replace).await.ok().unwrap();
    assert_eq!(ok.host_key, Some(super::client::HostKeyOutcome::Replaced));
    assert_eq!(
        env.known_hosts.list().unwrap()[0].fingerprint,
        super::fingerprint_sha256(&server.host_public)
    );
}

/// Same stores, but a UI that answers "Replace".
fn env_replace(base: &Env) -> Deps {
    let (tx, mut rx) = mpsc::unbounded_channel::<PromptEvent>();
    let prompts = Prompts::new(Arc::new(move |e| {
        let _ = tx.send(e);
    }));
    let p = prompts.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let (id, answer) = match &event {
                PromptEvent::HostKey { prompt_id, .. } => {
                    (*prompt_id, Answer::HostKey(HostKeyDecision::Replace))
                }
                PromptEvent::Auth { prompt_id, .. } => (*prompt_id, secrets(&["pw"])),
            };
            p.answer(id, answer);
        }
    });
    let mut deps = base.deps();
    deps.prompts = prompts;
    deps
}

// --- sessions --------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn several_sessions_are_independent() {
    let server = TestServer::start(password_server("tester", "pw")).await;
    let env = env(trust_and_password("pw"));
    let t = target(server.port, "tester", AuthMethod::Password);
    let a = start_session(&env, t.clone(), None);
    let b = start_session(&env, t.clone(), None);
    let c = start_session(&env, t, None);
    for s in [&a, &b, &c] {
        s.sink
            .wait_until("banner", |k| k.text().contains("ready"))
            .await;
    }
    assert_ne!(a.session.id, b.session.id);
    a.session.write(b"only-a\n".to_vec()).await;
    b.session.write(b"only-b\n".to_vec()).await;
    a.sink
        .wait_until("a echo", |k| k.text().contains("only-a"))
        .await;
    b.sink
        .wait_until("b echo", |k| k.text().contains("only-b"))
        .await;
    assert!(
        !a.sink.text().contains("only-b")
            && !b.sink.text().contains("only-a")
            && !c.sink.text().contains("only-")
    );
    // closing one leaves the others running
    a.session.close().await;
    a.sink
        .wait_until("closed", |k| k.closed_reason().is_some())
        .await;
    c.session.write(b"still-here\n".to_vec()).await;
    c.sink
        .wait_until("c echo", |k| k.text().contains("still-here"))
        .await;
    b.session.close().await;
    c.session.close().await;
    assert_eq!(server.rec.connections.load(Ordering::SeqCst), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn failures_are_reported_with_a_fixed_reason_and_cleaned_up() {
    // nothing listens on this port
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let env = env(trust_and_password("pw"));
    let s = start_session(&env, target(port, "tester", AuthMethod::Password), None);
    s.sink
        .wait_until("closed", |k| k.closed_reason().is_some())
        .await;
    assert_eq!(
        s.sink.closed_reason(),
        Some(Some("connect_failed".to_owned()))
    );
    assert_eq!(s.sink.states().last(), Some(&SessionState::Failed));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(s.ended.lock().unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_while_a_question_is_pending_cancels_the_connection() {
    let server = TestServer::start(password_server("tester", "pw")).await;
    // a UI that never answers
    let env = {
        let dir = tempfile::tempdir().unwrap();
        Env {
            known_hosts: Arc::new(KnownHostsStore::open(dir.path().join("k.json")).unwrap()),
            credentials: Arc::new(MemoryCredentialStore::new()),
            prompts: Prompts::new(Arc::new(|_| {})),
            events: Arc::default(),
            dir,
        }
    };
    let s = start_session(
        &env,
        target(server.port, "tester", AuthMethod::Password),
        None,
    );
    for _ in 0..200 {
        if env.prompts.pending_count() > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        env.prompts.pending_count(),
        1,
        "host-key question is waiting"
    );
    s.session.close().await;
    s.sink
        .wait_until("closed", |k| k.closed_reason().is_some())
        .await;
    assert_eq!(env.prompts.pending_count(), 0);
    assert_eq!(server.rec.auth_attempts.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn output_is_throttled_until_the_renderer_acknowledges_it() {
    use super::session::MAX_OUTSTANDING;
    let server = TestServer::start(password_server("tester", "pw")).await;
    let env = env(trust_and_password("pw"));
    let s = start_session(
        &env,
        target(server.port, "tester", AuthMethod::Password),
        None,
    );
    s.sink
        .wait_until("banner", |k| k.text().contains("ready"))
        .await;
    s.session.credits.ack(usize::MAX); // everything so far is acknowledged
    s.session.write(b"flood\n".to_vec()).await; // 2 MiB of output
    // Without acknowledgements the pipeline must stall near the limit.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let stalled = s.session.credits.outstanding();
    assert!(
        stalled >= MAX_OUTSTANDING,
        "should reach the limit, got {stalled}"
    );
    assert!(
        stalled < MAX_OUTSTANDING + 2 * 1024 * 1024,
        "bounded buffering, got {stalled}"
    );
    assert!(
        !s.sink.text().contains("flood-done"),
        "must not have delivered everything yet"
    );
    // Acknowledge continuously, like the renderer does; everything then arrives.
    let credits = s.session.credits.clone();
    let acker = tokio::spawn(async move {
        loop {
            credits.ack(64 * 1024);
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    });
    s.sink
        .wait_until("rest", |k| k.text().contains("flood-done"))
        .await;
    acker.abort();
    let xs = s.sink.text().matches('x').count();
    assert_eq!(xs, 64 * 32 * 1024, "no output lost or duplicated");
    s.session.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn initial_directory_is_typed_quoted_and_dangerous_names_are_refused() {
    assert_eq!(
        session::shell_quote("/var/www").as_deref(),
        Some("'/var/www'")
    );
    assert_eq!(
        session::shell_quote("/a b/it's").as_deref(),
        Some("'/a b/it'\\''s'")
    );
    assert_eq!(session::shell_quote("/x\nrm -rf /"), None);
    let server = TestServer::start(password_server("tester", "pw")).await;
    let env = env(trust_and_password("pw"));
    let s = start_session(
        &env,
        target(server.port, "tester", AuthMethod::Password),
        Some("/srv/it's"),
    );
    s.sink
        .wait_until("cd echoed", |k| k.text().contains("cd -- '/srv/it'\\''s'"))
        .await;
    s.session.close().await;
}

#[test]
fn session_events_are_camel_case_and_data_is_base64() {
    let json = serde_json::to_value(TerminalEvent::Data {
        data: session::encode(b"hi"),
    })
    .unwrap();
    assert_eq!(json["kind"], "data");
    assert_eq!(json["data"], "aGk=");
}
