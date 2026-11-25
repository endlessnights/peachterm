// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::lock::LockFlag;
use crate::sessions::SessionId;
use crate::ssh::integration::{
    Started, env, password_server, start_session_locked, target, trust_and_password,
};
use crate::ssh::testserver::{ExecMode, TestServer};
use crate::storage::connections::AuthMethod;
use std::sync::atomic::Ordering;

const GOOD: &str = "@@os\nLinux\n@@id\nuid=1000(vps112) gid=1000(vps112) groups=1000(vps112),27(sudo),998(docker)\n\
@@ls\ndrwxr-xr-x 3 root root 4096 Jan  1 00:00 /opt/l2/releases\n\
@@namei\nf: /opt/l2/releases\n dr-xr-xr-x root root /\n drwxr-xr-x root root opt\n drwxr-xr-x root root l2\n drwxr-xr-x root root releases\n\
@@access\nw=no\nx=yes\n@@end\n";

// ------------------------------------------------------------ the command

#[test]
fn safe_paths_are_absolute_bounded_and_free_of_quotes_and_control_characters() {
    for ok in [
        "/",
        "/opt/l2/releases",
        "/opt/my dir/ü 日本",
        "/a$b;c&d|e>f",
        "/x\"y",
        "/-rf",
    ] {
        assert_eq!(safe_path(ok), Some(ok), "{ok:?}");
    }
    let long = format!("/{}", "a".repeat(MAX_PATH));
    for bad in [
        "",
        "relative",
        "./x",
        "-rf",
        "/it's",
        "/bang!",
        "/new\nline",
        "/nul\0",
        "/tab\t",
        "/esc\x1b[0m",
        &long,
    ] {
        assert_eq!(safe_path(bad), None, "{bad:?}");
    }
}

#[test]
fn the_command_is_a_fixed_script_with_the_path_as_a_quoted_argument() {
    let cmd = command(Some("/opt/my dir"));
    assert!(cmd.starts_with("sh -c '"), "{cmd}");
    assert!(cmd.ends_with("' sh '/opt/my dir'"), "{cmd}");
    // read-only tools only
    for forbidden in [
        "sudo", "rm ", "chmod", "chown", "chgrp", "mv ", "cp ", "touch", "mkdir", "tee", ">>",
        "kill",
    ] {
        assert!(!cmd.contains(forbidden), "{forbidden}");
    }
    // the script text is identical whatever the path is
    let a = command(Some("/a"));
    let b = command(Some("/some/other/place"));
    assert_eq!(
        a.rsplit_once("' sh '").unwrap().0,
        b.rsplit_once("' sh '").unwrap().0
    );
}

#[test]
fn an_unsafe_path_is_never_part_of_any_command() {
    for bad in [
        "/x'; touch /tmp/pwned; echo '",
        "/a`id`'",
        "/p\nid",
        "/a!b",
        "relative/path",
    ] {
        let cmd = command(Some(bad));
        assert!(!cmd.contains("touch"), "{cmd}");
        assert!(!cmd.contains(bad), "{cmd}");
        assert!(
            !cmd.contains("\"$1\""),
            "no path probes without a safe path: {cmd}"
        );
    }
    assert!(!command(None).contains("\"$1\""));
}

#[cfg(unix)]
#[test]
fn shell_metacharacters_in_a_path_cannot_run_anything() {
    // Run the real command line through a real shell with hostile (but accepted) paths.
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("pwned");
    let hostile = [
        format!("/x; touch {}", marker.display()),
        format!("/x$(touch {})", marker.display()),
        format!("/x`touch {}`", marker.display()),
        format!("/x && touch {} #", marker.display()),
        format!("/x | touch {}", marker.display()),
        "/-la with spaces and \"double quotes\" and $HOME".to_string(),
        "/--help".to_string(),
    ];
    for path in hostile {
        let cmd = command(Some(&path));
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .output()
            .unwrap();
        assert!(!marker.exists(), "{path:?} executed something");
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("@@end"), "the script finished for {path:?}");
    }
}

// ----------------------------------------------------------------- parsing

#[test]
fn a_complete_answer_is_parsed_into_validated_fields() {
    let r = parse_output(GOOD, Some("/opt/l2/releases"), false);
    assert_eq!(r.platform, Platform::Linux);
    assert_eq!(r.exec, Exec::Ok);
    let user = r.user.unwrap();
    assert_eq!(
        (user.uid, user.gid, user.name.as_str()),
        (1000, 1000, "vps112")
    );
    assert_eq!(
        user.groups
            .iter()
            .map(|g| g.name.as_str())
            .collect::<Vec<_>>(),
        ["vps112", "sudo", "docker"]
    );
    let t = r.target.unwrap();
    assert_eq!(
        (t.mode.as_str(), t.owner.as_str(), t.group.as_str()),
        ("drwxr-xr-x", "root", "root")
    );
    assert_eq!(r.chain.len(), 4);
    assert_eq!(r.chain[3].name, "releases");
    assert_eq!(
        r.access,
        Some(Access {
            write: false,
            search: true
        })
    );
    assert!(r.unsupported.is_empty());
    assert!(!r.path_refused);
}

#[test]
fn missing_tools_and_odd_output_degrade_gracefully() {
    // no namei, no id, a non-Linux system
    let r = parse_output(
        "@@os\nFreeBSD\n@@id\n@@ls\n@@namei\n@@access\n@@end\n",
        Some("/x"),
        false,
    );
    assert_eq!(r.platform, Platform::Other);
    assert!(r.user.is_none() && r.target.is_none() && r.access.is_none());
    for probe in ["id", "ls", "namei", "access"] {
        assert!(r.unsupported.iter().any(|u| u == probe), "{probe}");
    }
    // garbage: nothing panics, nothing invented
    for junk in [
        "",
        "random text",
        "@@id\nuid=abc gid=\n",
        "@@ls\nnot-a-mode a b c\n",
        "\u{0}\u{1}@@@@\n@@\n",
    ] {
        let r = parse_output(junk, Some("/x"), false);
        assert!(
            r.user.is_none() && r.target.is_none() && r.access.is_none(),
            "{junk:?}"
        );
        assert_eq!(r.platform, Platform::Unknown);
    }
}

#[test]
fn hostile_remote_text_is_cleaned_and_bounded() {
    let owner = format!("evil\u{1b}[31m{}", "x".repeat(500));
    let text = format!(
        "@@os\nLinux\n@@id\nuid=0(root\u{7}) gid=0(root) groups=0(root)\n@@ls\ndrwxr-xr-x 1 {owner} grp 0 x y\n@@namei\n{}@@access\nw=yes\nx=maybe\n",
        (0..100)
            .map(|i| format!(" drwxr-xr-x a b dir{i}\n"))
            .collect::<String>()
    );
    let r = parse_output(&text, Some("/x"), false);
    assert!(r.user.unwrap().name.chars().all(|c| !c.is_control()));
    let t = r.target.unwrap();
    assert!(t.owner.chars().count() <= MAX_FIELD && !t.owner.contains('\u{1b}'));
    assert!(r.chain.len() <= MAX_CHAIN);
    assert_eq!(r.access, None, "an unexpected value is not interpreted");
}

#[test]
fn acl_and_special_mode_markers_are_accepted() {
    assert!(valid_mode("drwxr-xr-x+"));
    assert!(valid_mode("drwxrwsr-x"));
    assert!(valid_mode("-rwsr-xr-x"));
    assert!(valid_mode("drwxrwxrwt"));
    assert!(!valid_mode("hello"));
    assert!(!valid_mode("drwxr-xr-x; rm"));
}

// ------------------------------------------------------------ real session

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
    std::mem::forget(env);
    s
}

async fn server(mode: ExecMode) -> TestServer {
    let mut o = password_server("u", "pw");
    o.exec = mode;
    TestServer::start(o).await
}

#[tokio::test(flavor = "multi_thread")]
async fn one_exec_channel_with_the_fixed_command_and_nothing_typed_into_the_terminal() {
    let srv = server(ExecMode::Outputs(vec![GOOD.as_bytes().to_vec()])).await;
    let s = connected(&srv, LockFlag::default()).await;
    let handle = s.session.transport.get().unwrap().clone();
    let r = diagnose(&handle, Some("/opt/l2/releases"), TIMEOUT).await;
    assert_eq!(r.exec, Exec::Ok);
    assert_eq!(r.platform, Platform::Linux);
    assert_eq!(r.target.unwrap().owner, "root");
    let execs = srv.rec.execs.lock().unwrap().clone();
    assert_eq!(execs, vec![command(Some("/opt/l2/releases"))]);
    assert!(
        srv.rec.input.lock().unwrap().is_empty(),
        "no keystrokes in the shell"
    );
    assert_eq!(
        srv.rec.shells.load(Ordering::SeqCst),
        1,
        "no extra shell or session"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_path_with_spaces_and_quotes_is_probed_or_refused_never_interpreted() {
    let srv = server(ExecMode::Outputs(vec![GOOD.as_bytes().to_vec()])).await;
    let s = connected(&srv, LockFlag::default()).await;
    let handle = s.session.transport.get().unwrap().clone();
    // spaces are fine and travel as one quoted argument
    diagnose(&handle, Some("/opt/my dir"), TIMEOUT).await;
    // an injection attempt is refused before anything is sent
    let r = diagnose(&handle, Some("/x'; id; echo '"), TIMEOUT).await;
    assert!(r.path_refused && r.path.is_none());
    let execs = srv.rec.execs.lock().unwrap().clone();
    assert_eq!(execs.len(), 2);
    assert!(execs[0].ends_with("' sh '/opt/my dir'"));
    assert!(!execs[1].contains("id; echo"), "{}", execs[1]);
    assert!(!execs[1].contains("\"$1\""), "only the generic probe ran");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_without_exec_channels_gets_the_generic_answer() {
    let srv = server(ExecMode::Refuse).await;
    let s = connected(&srv, LockFlag::default()).await;
    let handle = s.session.transport.get().unwrap().clone();
    let r = diagnose(&handle, Some("/opt"), TIMEOUT).await;
    assert_eq!(r.exec, Exec::Unavailable);
    assert!(r.user.is_none() && r.target.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_silent_server_times_out_and_the_channel_is_released() {
    let srv = server(ExecMode::Hang).await;
    let s = connected(&srv, LockFlag::default()).await;
    let handle = s.session.transport.get().unwrap().clone();
    let started = std::time::Instant::now();
    let r = diagnose(&handle, Some("/opt"), Duration::from_millis(600)).await;
    assert_eq!(r.exec, Exec::Timeout);
    assert!(started.elapsed() < Duration::from_secs(5));
    // the session still works: the terminal and later probes are unaffected
    assert_eq!(s.session.state(), crate::ssh::SessionState::Connected);
}

#[tokio::test(flavor = "multi_thread")]
async fn oversized_output_is_refused() {
    let srv = server(ExecMode::Outputs(vec![vec![b'x'; MAX_OUTPUT + 10]])).await;
    let s = connected(&srv, LockFlag::default()).await;
    let handle = s.session.transport.get().unwrap().clone();
    let r = diagnose(&handle, Some("/opt"), TIMEOUT).await;
    assert_eq!(r.exec, Exec::Failed);
    assert!(r.user.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn unexpected_output_from_the_server_is_not_trusted() {
    let srv = server(ExecMode::Outputs(vec![
        b"<script>alert(1)</script>\n@@id\nrm -rf /\n".to_vec(),
    ]))
    .await;
    let s = connected(&srv, LockFlag::default()).await;
    let handle = s.session.transport.get().unwrap().clone();
    let r = diagnose(&handle, Some("/opt"), TIMEOUT).await;
    assert_eq!(r.exec, Exec::Ok);
    assert!(r.user.is_none() && r.target.is_none() && r.chain.is_empty());
    let json = serde_json::to_string(&r).unwrap();
    assert!(
        !json.contains("script") && !json.contains("rm -rf"),
        "{json}"
    );
}
