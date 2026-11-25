// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! "Diagnose Permissions": an explicit, read-only look at why an SFTP operation
//! was refused.
//!
//! * Started only by the user (the renderer asks after a permission error).
//! * One short-lived `exec` channel on the session's existing authenticated
//!   transport. Nothing is ever typed into the interactive terminal, no PTY,
//!   no `sudo`, nothing is written on the server.
//! * One **fixed** script. The only variable part is the remote directory,
//!   passed as a positional argument inside single quotes after it passed a
//!   strict check ([`safe_path`]); a path that cannot be represented safely is
//!   not probed at all (the report then says so and gives generic guidance).
//! * 8 second timeout, 16 KiB output limit, the channel is always closed.
//! * Output is untrusted: it is parsed into a handful of validated, bounded
//!   fields. The raw text is neither returned, logged nor stored.

use russh::ChannelMsg;
use serde::Serialize;
use std::time::Duration;

pub const TIMEOUT: Duration = Duration::from_secs(8);
pub const MAX_OUTPUT: usize = 16 * 1024;
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_PATH: usize = 1024;
const MAX_CHAIN: usize = 16;
const MAX_GROUPS: usize = 64;
const MAX_FIELD: usize = 64;

/// The script run on the server. Fixed text: no part of it comes from the user.
/// `$1` is the directory (quoted by the shell); without a path the path probes
/// are skipped. It contains no single quote and no history-expansion characters,
/// so it is inert in any login shell. Only reads (`id`, `uname`, `ls`, `namei`, `test`).
const SCRIPT_WITH_PATH: &str = "LC_ALL=C; export LC_ALL; echo @@os; uname -s 2>/dev/null; \
echo @@id; id 2>/dev/null; \
echo @@ls; ls -ld -- \"$1\" 2>/dev/null; \
echo @@namei; namei -l -- \"$1\" 2>/dev/null; \
echo @@access; if [ -w \"$1\" ]; then echo w=yes; else echo w=no; fi; \
if [ -x \"$1\" ]; then echo x=yes; else echo x=no; fi; \
echo @@end";
const SCRIPT_NO_PATH: &str = "LC_ALL=C; export LC_ALL; echo @@os; uname -s 2>/dev/null; \
echo @@id; id 2>/dev/null; echo @@end";

/// A remote directory that may be given to the probe. Absolute, bounded, no
/// control characters, and none of the characters that matter inside single
/// quotes (`'`) or to history expansion (`!`). Anything else is not probed.
pub fn safe_path(path: &str) -> Option<&str> {
    if path.is_empty() || path.len() > MAX_PATH || !path.starts_with('/') {
        return None;
    }
    if path
        .chars()
        .any(|c| c.is_control() || c == '\'' || c == '!')
    {
        return None;
    }
    Some(path)
}

/// The full command line for the login shell.
pub fn command(path: Option<&str>) -> String {
    match path.and_then(safe_path) {
        // `sh -c '<fixed script>' sh '<path>'`: the path is data for `$1`, never code.
        Some(path) => format!("sh -c '{SCRIPT_WITH_PATH}' sh '{path}'"),
        None => format!("sh -c '{SCRIPT_NO_PATH}'"),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Platform {
    Linux,
    Other,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Exec {
    Ok,
    /// The server refused an exec channel (SFTP-only accounts, chroot, policy).
    Unavailable,
    Timeout,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInfo {
    pub gid: u32,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub uid: u32,
    pub gid: u32,
    pub name: String,
    pub groups: Vec<GroupInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// `drwxr-xr-x` (a trailing `+` means an ACL is attached).
    pub mode: String,
    pub owner: String,
    pub group: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    /// The shell's own check (`test -w`), which also honours ACLs and read-only mounts.
    pub write: bool,
    pub search: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionReport {
    pub platform: Platform,
    pub exec: Exec,
    pub user: Option<UserInfo>,
    /// The directory that was inspected (absent when it could not be probed safely).
    pub path: Option<String>,
    /// The path contained characters that cannot be passed to a probe safely.
    pub path_refused: bool,
    pub target: Option<Entry>,
    /// The path from `/` down (`namei -l`), at most a few entries.
    pub chain: Vec<Entry>,
    pub access: Option<Access>,
    /// Probes that produced nothing usable (tool missing, unexpected output).
    pub unsupported: Vec<String>,
}

impl PermissionReport {
    fn empty(exec: Exec, path: Option<&str>, refused: bool) -> Self {
        Self {
            platform: Platform::Unknown,
            exec,
            user: None,
            path: path.map(str::to_owned),
            path_refused: refused,
            target: None,
            chain: Vec::new(),
            access: None,
            unsupported: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------- parsing

/// A name for display: printable, bounded, no markup-relevant surprises.
fn clean(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .take(MAX_FIELD)
        .collect()
}

fn sections(text: &str) -> std::collections::HashMap<&str, Vec<&str>> {
    let mut map: std::collections::HashMap<&str, Vec<&str>> = Default::default();
    let mut current: Option<&str> = None;
    for line in text.lines() {
        if let Some(name) = line.strip_prefix("@@") {
            current = Some(name.trim());
            map.entry(name.trim()).or_default();
        } else if let Some(name) = current {
            map.entry(name).or_default().push(line);
        }
    }
    map
}

/// `1000(vps112)` -> (1000, "vps112")
fn id_part(part: &str) -> Option<(u32, String)> {
    let open = part.find('(')?;
    let id = part[..open].trim().parse().ok()?;
    let name = part[open + 1..].trim_end().strip_suffix(')')?;
    Some((id, clean(name)))
}

/// `uid=1000(vps112) gid=1000(vps112) groups=1000(vps112),27(sudo)`
pub fn parse_id(line: &str) -> Option<UserInfo> {
    let mut uid = None;
    let mut gid = None;
    let mut groups = Vec::new();
    for field in line.split_whitespace() {
        if let Some(rest) = field.strip_prefix("uid=") {
            uid = id_part(rest);
        } else if let Some(rest) = field.strip_prefix("gid=") {
            gid = id_part(rest);
        } else if let Some(rest) = field.strip_prefix("groups=") {
            groups = rest
                .split(',')
                .filter_map(id_part)
                .take(MAX_GROUPS)
                .map(|(gid, name)| GroupInfo { gid, name })
                .collect();
        }
    }
    let (uid, name) = uid?;
    let (gid, _) = gid?;
    Some(UserInfo {
        uid,
        gid,
        name,
        groups,
    })
}

fn valid_mode(mode: &str) -> bool {
    let bytes = mode.as_bytes();
    (10..=11).contains(&bytes.len())
        && matches!(bytes[0], b'd' | b'-' | b'l' | b'c' | b'b' | b'p' | b's')
        && bytes[1..10]
            .iter()
            .all(|b| matches!(b, b'r' | b'w' | b'x' | b'-' | b's' | b'S' | b't' | b'T'))
        && (bytes.len() == 10 || matches!(bytes[10], b'+' | b'.' | b'@'))
}

/// `drwxr-xr-x 2 root root 4096 Jan  1 00:00 /opt/x` (the name is the request, not parsed).
pub fn parse_ls(line: &str) -> Option<Entry> {
    let mut parts = line.split_whitespace();
    let mode = parts.next()?;
    if !valid_mode(mode) {
        return None;
    }
    let _links = parts.next()?;
    let owner = parts.next()?;
    let group = parts.next()?;
    Some(Entry {
        mode: mode.to_owned(),
        owner: clean(owner),
        group: clean(group),
        name: String::new(),
    })
}

/// `namei -l`: a `f: <path>` header, then ` drwxr-xr-x root root /` style lines.
pub fn parse_namei(lines: &[&str]) -> Vec<Entry> {
    lines
        .iter()
        .filter(|l| !l.trim_start().starts_with("f:"))
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let mode = parts.next()?;
            if !valid_mode(mode) {
                return None;
            }
            let owner = parts.next()?;
            let group = parts.next()?;
            let name: Vec<&str> = parts.collect();
            Some(Entry {
                mode: mode.to_owned(),
                owner: clean(owner),
                group: clean(group),
                name: clean(&name.join(" ")),
            })
        })
        .take(MAX_CHAIN)
        .collect()
}

pub fn parse_output(text: &str, path: Option<&str>, refused: bool) -> PermissionReport {
    let map = sections(text);
    let mut report = PermissionReport::empty(Exec::Ok, path, refused);
    report.platform = match map.get("os").and_then(|l| l.first()).map(|s| s.trim()) {
        Some("Linux") => Platform::Linux,
        Some(_) => Platform::Other,
        None => Platform::Unknown,
    };
    report.user = map
        .get("id")
        .and_then(|lines| lines.iter().find_map(|l| parse_id(l)));
    if report.user.is_none() {
        report.unsupported.push("id".into());
    }
    if path.is_some() {
        report.target = map
            .get("ls")
            .and_then(|lines| lines.first())
            .and_then(|l| parse_ls(l));
        if report.target.is_none() {
            report.unsupported.push("ls".into());
        }
        report.chain = map.get("namei").map(|l| parse_namei(l)).unwrap_or_default();
        if report.chain.is_empty() {
            report.unsupported.push("namei".into());
        }
        let flag = |key: &str| {
            map.get("access")
                .and_then(|lines| lines.iter().find_map(|l| l.trim().strip_prefix(key)))
                .and_then(|v| match v {
                    "yes" => Some(true),
                    "no" => Some(false),
                    _ => None,
                })
        };
        report.access = match (flag("w="), flag("x=")) {
            (Some(write), Some(search)) => Some(Access { write, search }),
            _ => {
                report.unsupported.push("access".into());
                None
            }
        };
    }
    report
}

// ---------------------------------------------------------------- running

/// Runs the diagnostics over a fresh exec channel of `handle`.
pub async fn diagnose(
    handle: &crate::ssh::client::Handle,
    path: Option<&str>,
    limit: Duration,
) -> PermissionReport {
    let safe = path.and_then(safe_path);
    let refused = path.is_some() && safe.is_none();
    let cmd = command(safe);
    let mut channel = match tokio::time::timeout(limit, handle.channel_open_session()).await {
        Ok(Ok(c)) => c,
        Ok(Err(_)) => return PermissionReport::empty(Exec::Unavailable, safe, refused),
        Err(_) => return PermissionReport::empty(Exec::Timeout, safe, refused),
    };
    let work = async {
        channel
            .exec(true, cmd.as_bytes())
            .await
            .map_err(|_| Exec::Unavailable)?;
        let mut out: Vec<u8> = Vec::new();
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    if out.len() + data.len() > MAX_OUTPUT {
                        return Err(Exec::Failed);
                    }
                    out.extend_from_slice(&data);
                }
                Some(ChannelMsg::Failure) => return Err(Exec::Unavailable),
                Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            }
        }
        Ok(out)
    };
    let result = tokio::time::timeout(limit, work)
        .await
        .unwrap_or(Err(Exec::Timeout));
    // The channel is always released, also after a timeout.
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, channel.close()).await;
    match result {
        Ok(bytes) => parse_output(&String::from_utf8_lossy(&bytes), safe, refused),
        Err(exec) => PermissionReport::empty(exec, safe, refused),
    }
}

#[cfg(test)]
mod tests;
