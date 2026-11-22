// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Local shell profiles: which shells exist on this machine and how to start
//! them.
//!
//! The renderer only ever names a profile by **id**. The program and its
//! arguments are decided here, in Rust, and are passed to the operating system
//! as an argument vector (never through a shell, never built by string
//! concatenation), so nothing a user types or a file name contains can turn
//! into extra commands.
//!
//! Discovery goes through the [`Probe`] trait so every platform's rules can be
//! tested on any machine.

use serde::Serialize;
use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::storage::settings::{CustomShell, TerminalSettings};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Windows,
    Linux,
    Mac,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Local,
    Wsl,
}

/// What the renderer may know about a shell: no paths of arguments, only a label.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    /// Where it comes from (for example the executable's file name or the WSL distribution).
    pub detail: String,
}

/// How to start a profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub kind: Kind,
    /// WSL only: the distribution (so a start directory can be added as `--cd <dir>`).
    pub wsl_distro: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub profile: Profile,
    pub spec: Spec,
}

/// Everything discovery needs from the machine.
pub trait Probe {
    fn os(&self) -> Os;
    fn env(&self, name: &str) -> Option<OsString>;
    fn is_file(&self, path: &Path) -> bool;
    fn is_dir(&self, path: &Path) -> bool;
    /// Names of the entries of a directory (empty if it cannot be read).
    fn list_dir(&self, path: &Path) -> Vec<String>;
    /// Raw output of `wsl.exe --list --quiet` (UTF-16LE), if WSL can be asked.
    fn wsl_list(&self) -> Option<Vec<u8>>;
}

/// The real machine.
pub struct SystemProbe;

impl Probe for SystemProbe {
    fn os(&self) -> Os {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Mac
        } else {
            Os::Linux
        }
    }
    fn env(&self, name: &str) -> Option<OsString> {
        std::env::var_os(name)
    }
    fn is_file(&self, path: &Path) -> bool {
        path.is_file()
    }
    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }
    fn list_dir(&self, path: &Path) -> Vec<String> {
        std::fs::read_dir(path)
            .map(|rd| {
                rd.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    }
    #[cfg(windows)]
    fn wsl_list(&self) -> Option<Vec<u8>> {
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let exe = PathBuf::from(root).join("System32").join("wsl.exe");
        if !exe.is_file() {
            return None;
        }
        let mut child = Command::new(exe)
            .args(["--list", "--quiet"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .stdout(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .ok()?;
        // WSL can take long to answer when its VM has to start: wait a little, never hang.
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if started.elapsed() < Duration::from_secs(6) => {
                    std::thread::sleep(Duration::from_millis(40));
                }
                _ => {
                    let _ = child.kill();
                    return None;
                }
            }
        }
        let mut out = Vec::new();
        std::io::Read::read_to_end(&mut child.stdout.take()?, &mut out).ok()?;
        Some(out)
    }
    #[cfg(not(windows))]
    fn wsl_list(&self) -> Option<Vec<u8>> {
        None
    }
}

/// Distribution names from `wsl.exe --list --quiet` (UTF-16LE, usually with a
/// byte-order mark and CRLF). Names that are not plain identifiers are dropped,
/// and so are Docker Desktop's internal distributions.
pub fn parse_wsl_list(raw: &[u8]) -> Vec<String> {
    let units: Vec<u16> = raw
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
        .collect();
    let text = String::from_utf16_lossy(&units);
    let mut seen = HashSet::new();
    text.lines()
        .map(|l| l.trim_matches(|c: char| c == '\u{feff}' || c == '\0' || c.is_whitespace()))
        .filter(|name| distro_name_ok(name))
        .filter(|name| !name.to_ascii_lowercase().starts_with("docker-desktop"))
        .filter(|name| seen.insert((*name).to_owned()))
        .map(str::to_owned)
        .collect()
}

/// A WSL distribution name is passed as a separate argument, but it is still
/// held to a plain character set.
pub fn distro_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn push_unique(entries: &mut Vec<Entry>, entry: Entry) {
    if !entries.iter().any(|e| e.profile.id == entry.profile.id) {
        entries.push(entry);
    }
}

fn local(id: &str, name: &str, program: PathBuf, args: &[&str]) -> Entry {
    let detail = program
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Entry {
        profile: Profile {
            id: id.into(),
            name: name.into(),
            kind: Kind::Local,
            detail,
        },
        spec: Spec {
            program,
            args: args.iter().map(OsString::from).collect(),
            kind: Kind::Local,
            wsl_distro: None,
        },
    }
}

fn path_dirs(probe: &dyn Probe) -> Vec<PathBuf> {
    probe
        .env("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default()
}

/// First `name` found on `PATH`.
fn on_path(probe: &dyn Probe, name: &str) -> Option<PathBuf> {
    path_dirs(probe)
        .into_iter()
        .map(|d| d.join(name))
        .find(|p| probe.is_file(p))
}

fn windows(probe: &dyn Probe, entries: &mut Vec<Entry>) {
    let system_root = probe
        .env("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Windows"));
    let system32 = system_root.join("System32");

    // Windows PowerShell 5.1: part of Windows, the fallback default.
    let ps5 = system32
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if probe.is_file(&ps5) {
        push_unique(
            entries,
            local("powershell", "Windows PowerShell", ps5, &["-NoLogo"]),
        );
    }

    // PowerShell 7: never assumed. PATH first, then the usual install places.
    let mut candidates: Vec<PathBuf> = path_dirs(probe)
        .into_iter()
        .map(|d| d.join("pwsh.exe"))
        .collect();
    for var in ["ProgramFiles", "ProgramW6432"] {
        if let Some(pf) = probe.env(var).map(PathBuf::from) {
            let base = pf.join("PowerShell");
            let mut versions: Vec<String> = probe
                .list_dir(&base)
                .into_iter()
                .filter(|n| {
                    n.chars().next().is_some_and(|c| c.is_ascii_digit()) && !n.contains("preview")
                })
                .collect();
            versions.sort_by_key(|v| std::cmp::Reverse(v.parse::<u32>().unwrap_or(0)));
            candidates.extend(versions.into_iter().map(|v| base.join(v).join("pwsh.exe")));
        }
    }
    if let Some(local_app) = probe.env("LOCALAPPDATA").map(PathBuf::from) {
        candidates.push(
            local_app
                .join("Microsoft")
                .join("WindowsApps")
                .join("pwsh.exe"),
        );
    }
    if let Some(found) = candidates.into_iter().find(|p| probe.is_file(p)) {
        push_unique(entries, local("pwsh", "PowerShell 7", found, &["-NoLogo"]));
    }

    // Command Prompt.
    let comspec = probe
        .env("ComSpec")
        .map(PathBuf::from)
        .filter(|p| probe.is_file(p))
        .unwrap_or_else(|| system32.join("cmd.exe"));
    if probe.is_file(&comspec) {
        push_unique(entries, local("cmd", "Command Prompt", comspec, &[]));
    }

    // WSL: only distributions that are really installed; nothing is installed here.
    if let Some(raw) = probe.wsl_list() {
        let wsl = system32.join("wsl.exe");
        for distro in parse_wsl_list(&raw) {
            entries.push(Entry {
                profile: Profile {
                    id: format!("wsl:{distro}"),
                    name: format!("{distro} (WSL)"),
                    kind: Kind::Wsl,
                    detail: distro.clone(),
                },
                spec: Spec {
                    program: wsl.clone(),
                    args: vec!["-d".into(), distro.clone().into()],
                    kind: Kind::Wsl,
                    wsl_distro: Some(distro),
                },
            });
        }
    }
}

fn unix(probe: &dyn Probe, entries: &mut Vec<Entry>) {
    let mut taken: Vec<PathBuf> = Vec::new();
    // The user's own login shell first.
    if let Some(shell) = probe
        .env("SHELL")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && probe.is_file(p))
    {
        let name = shell
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "shell".into());
        taken.push(shell.clone());
        push_unique(
            entries,
            local("login", &format!("Login shell ({name})"), shell, &["-l"]),
        );
    }
    let dirs = [
        "/bin",
        "/usr/bin",
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/run/current-system/sw/bin",
    ];
    for (id, name) in [("zsh", "Zsh"), ("bash", "Bash"), ("fish", "Fish")] {
        let found = dirs
            .iter()
            .map(|d| Path::new(d).join(id))
            .find(|p| probe.is_file(p))
            .or_else(|| on_path(probe, id));
        if let Some(path) = found
            && !taken.contains(&path)
        {
            taken.push(path.clone());
            push_unique(entries, local(id, name, path, &["-l"]));
        }
    }
    if entries.is_empty() {
        let sh = PathBuf::from("/bin/sh");
        if probe.is_file(&sh) {
            push_unique(entries, local("sh", "Shell (sh)", sh, &[]));
        }
    }
}

fn custom(probe: &dyn Probe, shells: &[CustomShell], entries: &mut Vec<Entry>) {
    for shell in shells {
        let program = PathBuf::from(&shell.program);
        // only an absolute path to an existing file; no PATH search, no shell
        if !program.is_absolute() || !probe.is_file(&program) {
            continue;
        }
        let id = format!("custom:{}", shell.id);
        push_unique(
            entries,
            Entry {
                profile: Profile {
                    id,
                    name: shell.name.clone(),
                    kind: Kind::Local,
                    detail: program
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                },
                spec: Spec {
                    program,
                    args: shell.args.iter().map(OsString::from).collect(),
                    kind: Kind::Local,
                    wsl_distro: None,
                },
            },
        );
    }
}

/// Every shell that can be started here. The preferred WSL distribution is
/// listed before the others.
pub fn discover(probe: &dyn Probe, settings: &TerminalSettings) -> Vec<Entry> {
    let mut entries = Vec::new();
    match probe.os() {
        Os::Windows => windows(probe, &mut entries),
        Os::Linux | Os::Mac => unix(probe, &mut entries),
    }
    custom(probe, &settings.custom_profiles, &mut entries);
    if let Some(preferred) = settings.wsl_distro.as_deref() {
        let id = format!("wsl:{preferred}");
        if let Some(i) = entries.iter().position(|e| e.profile.id == id) {
            let entry = entries.remove(i);
            let first_wsl = entries
                .iter()
                .position(|e| e.profile.kind == Kind::Wsl)
                .unwrap_or(entries.len());
            entries.insert(first_wsl, entry);
        }
    }
    entries
}

/// The profile a plain click on `+` starts: the configured one if it exists,
/// otherwise Windows PowerShell on Windows and the login shell elsewhere.
pub fn default_id(entries: &[Entry], settings: &TerminalSettings, os: Os) -> Option<String> {
    let has = |id: &str| entries.iter().any(|e| e.profile.id == id);
    if let Some(id) = settings.default_profile.as_deref() {
        // "wsl" means: the preferred distribution (or the first one)
        if id == "wsl" {
            let preferred = settings.wsl_distro.as_deref().map(|d| format!("wsl:{d}"));
            if let Some(p) = preferred.filter(|p| has(p)) {
                return Some(p);
            }
            if let Some(first) = entries.iter().find(|e| e.profile.kind == Kind::Wsl) {
                return Some(first.profile.id.clone());
            }
        } else if has(id) {
            return Some(id.to_owned());
        }
    }
    let preferred = match os {
        Os::Windows => "powershell",
        Os::Linux | Os::Mac => "login",
    };
    if has(preferred) {
        Some(preferred.to_owned())
    } else {
        entries.first().map(|e| e.profile.id.clone())
    }
}

/// Add the start directory to a spec. It must be an existing directory.
pub fn with_start_dir(spec: &Spec, dir: Option<&Path>) -> (Spec, Option<PathBuf>) {
    let mut spec = spec.clone();
    let Some(dir) = dir else {
        return (spec, None);
    };
    if spec.kind == Kind::Wsl {
        // wsl.exe understands `--cd <directory>` (a separate argument).
        spec.args.push("--cd".into());
        spec.args.push(dir.as_os_str().to_owned());
        return (spec, None);
    }
    (spec, Some(dir.to_path_buf()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    #[derive(Default)]
    struct Fake {
        os: Option<Os>,
        env: HashMap<String, OsString>,
        files: HashSet<PathBuf>,
        dirs: HashMap<PathBuf, Vec<String>>,
        wsl: Option<Vec<u8>>,
    }

    impl Fake {
        fn windows() -> Self {
            let mut f = Fake {
                os: Some(Os::Windows),
                ..Default::default()
            };
            f.env.insert("SystemRoot".into(), "C:\\Windows".into());
            f.files.insert(
                PathBuf::from("C:\\Windows")
                    .join("System32")
                    .join("WindowsPowerShell")
                    .join("v1.0")
                    .join("powershell.exe"),
            );
            f.files.insert(
                PathBuf::from("C:\\Windows")
                    .join("System32")
                    .join("cmd.exe"),
            );
            f
        }
        fn file(mut self, p: PathBuf) -> Self {
            self.files.insert(p);
            self
        }
    }

    impl Probe for Fake {
        fn os(&self) -> Os {
            self.os.unwrap_or(Os::Linux)
        }
        fn env(&self, name: &str) -> Option<OsString> {
            self.env.get(name).cloned()
        }
        fn is_file(&self, p: &Path) -> bool {
            self.files.contains(p)
        }
        fn is_dir(&self, p: &Path) -> bool {
            self.dirs.contains_key(p)
        }
        fn list_dir(&self, p: &Path) -> Vec<String> {
            self.dirs.get(p).cloned().unwrap_or_default()
        }
        fn wsl_list(&self) -> Option<Vec<u8>> {
            self.wsl.clone()
        }
    }

    fn utf16(text: &str) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xfe];
        bytes.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        bytes
    }

    fn ids(entries: &[Entry]) -> Vec<&str> {
        entries.iter().map(|e| e.profile.id.as_str()).collect()
    }

    fn settings() -> TerminalSettings {
        TerminalSettings::default()
    }

    #[cfg(windows)]
    #[test]
    fn windows_without_powershell_7_offers_windows_powershell_and_cmd_and_defaults_to_the_former() {
        let fake = Fake::windows();
        let entries = discover(&fake, &settings());
        assert_eq!(ids(&entries), ["powershell", "cmd"]);
        assert_eq!(
            default_id(&entries, &settings(), Os::Windows).as_deref(),
            Some("powershell")
        );
        assert!(
            !entries.iter().any(|e| e.profile.id == "pwsh"),
            "never assumed"
        );
    }

    #[cfg(windows)]
    #[test]
    fn powershell_7_is_found_on_path_or_in_program_files_and_is_selectable_as_default() {
        // on PATH
        let mut fake = Fake::windows().file(PathBuf::from("D:\\tools\\pwsh.exe"));
        fake.env.insert("PATH".into(), "C:\\x;D:\\tools".into());
        let entries = discover(&fake, &settings());
        let pwsh = entries
            .iter()
            .find(|e| e.profile.id == "pwsh")
            .expect("pwsh");
        assert_eq!(pwsh.spec.program, PathBuf::from("D:\\tools\\pwsh.exe"));
        assert_eq!(pwsh.profile.name, "PowerShell 7");
        // chosen as the default
        let chosen = TerminalSettings {
            default_profile: Some("pwsh".into()),
            ..settings()
        };
        assert_eq!(
            default_id(&entries, &chosen, Os::Windows).as_deref(),
            Some("pwsh")
        );

        // in Program Files, the newest numbered folder wins; previews are ignored
        let pf = PathBuf::from("C:\\Program Files");
        let mut fake = Fake::windows()
            .file(pf.join("PowerShell").join("7").join("pwsh.exe"))
            .file(pf.join("PowerShell").join("8").join("pwsh.exe"))
            .file(pf.join("PowerShell").join("7-preview").join("pwsh.exe"));
        fake.env
            .insert("ProgramFiles".into(), pf.clone().into_os_string());
        fake.dirs.insert(
            pf.join("PowerShell"),
            vec!["7".into(), "8".into(), "7-preview".into(), "Modules".into()],
        );
        let entries = discover(&fake, &settings());
        let pwsh = entries.iter().find(|e| e.profile.id == "pwsh").unwrap();
        assert_eq!(
            pwsh.spec.program,
            pf.join("PowerShell").join("8").join("pwsh.exe")
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_configured_default_that_no_longer_exists_falls_back_to_windows_powershell() {
        let entries = discover(&Fake::windows(), &settings());
        let gone = TerminalSettings {
            default_profile: Some("pwsh".into()),
            ..settings()
        };
        assert_eq!(
            default_id(&entries, &gone, Os::Windows).as_deref(),
            Some("powershell")
        );
        let nothing: Vec<Entry> = Vec::new();
        assert_eq!(default_id(&nothing, &gone, Os::Windows), None);
    }

    #[cfg(windows)]
    #[test]
    fn wsl_distributions_come_from_the_utf16_listing_and_only_real_ones_appear() {
        let mut fake = Fake::windows();
        fake.wsl = Some(utf16(
            "Ubuntu\r\nDebian\r\ndocker-desktop\r\ndocker-desktop-data\r\nbad name;rm\r\nUbuntu\r\n",
        ));
        let entries = discover(&fake, &settings());
        assert_eq!(
            ids(&entries),
            ["powershell", "cmd", "wsl:Ubuntu", "wsl:Debian"]
        );
        let ubuntu = entries
            .iter()
            .find(|e| e.profile.id == "wsl:Ubuntu")
            .unwrap();
        assert_eq!(ubuntu.profile.kind, Kind::Wsl);
        assert_eq!(ubuntu.profile.name, "Ubuntu (WSL)");
        // an argument vector, not a command line
        assert_eq!(
            ubuntu.spec.args,
            vec![OsString::from("-d"), OsString::from("Ubuntu")]
        );
        assert!(ubuntu.spec.program.ends_with("wsl.exe"));
    }

    #[cfg(windows)]
    #[test]
    fn without_wsl_nothing_is_listed() {
        let entries = discover(&Fake::windows(), &settings());
        assert!(entries.iter().all(|e| e.profile.kind != Kind::Wsl));
        let mut empty = Fake::windows();
        empty.wsl = Some(utf16("\r\n"));
        assert!(
            discover(&empty, &settings())
                .iter()
                .all(|e| e.profile.kind != Kind::Wsl)
        );
    }

    #[cfg(windows)]
    #[test]
    fn the_preferred_distribution_is_first_and_the_generic_wsl_default_uses_it() {
        let mut fake = Fake::windows();
        fake.wsl = Some(utf16("Ubuntu\r\nDebian\r\n"));
        let s = TerminalSettings {
            wsl_distro: Some("Debian".into()),
            default_profile: Some("wsl".into()),
            ..settings()
        };
        let entries = discover(&fake, &s);
        assert_eq!(
            ids(&entries),
            ["powershell", "cmd", "wsl:Debian", "wsl:Ubuntu"]
        );
        assert_eq!(
            default_id(&entries, &s, Os::Windows).as_deref(),
            Some("wsl:Debian")
        );
        // preferred distribution not installed: the first installed one
        let s2 = TerminalSettings {
            wsl_distro: Some("Gone".into()),
            default_profile: Some("wsl".into()),
            ..settings()
        };
        let e2 = discover(&fake, &s2);
        assert_eq!(
            default_id(&e2, &s2, Os::Windows).as_deref(),
            Some("wsl:Ubuntu")
        );
    }

    #[test]
    fn the_wsl_listing_parser_survives_odd_input() {
        assert_eq!(parse_wsl_list(&utf16("Ubuntu-22.04\r\n")), ["Ubuntu-22.04"]);
        assert!(parse_wsl_list(b"").is_empty());
        assert!(parse_wsl_list(&[0xff]).is_empty());
        assert!(parse_wsl_list(&utf16("a b\nx/y\n$(id)\n")).is_empty());
        // garbage bytes never panic
        let _ = parse_wsl_list(&[0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0xff]);
        assert!(distro_name_ok("Ubuntu-24.04"));
        assert!(!distro_name_ok(""));
        assert!(!distro_name_ok(&"x".repeat(100)));
    }

    #[cfg(unix)]
    #[test]
    fn unix_prefers_the_login_shell_and_lists_the_installed_ones_once() {
        let mut fake = Fake {
            os: Some(Os::Linux),
            ..Default::default()
        };
        fake.env.insert("SHELL".into(), "/usr/bin/zsh".into());
        for f in ["/usr/bin/zsh", "/bin/bash", "/usr/bin/fish"] {
            fake.files.insert(PathBuf::from(f));
        }
        let entries = discover(&fake, &settings());
        assert_eq!(ids(&entries), ["login", "bash", "fish"]); // zsh is the login shell: not repeated
        assert_eq!(entries[0].profile.name, "Login shell (zsh)");
        assert_eq!(entries[0].spec.args, vec![OsString::from("-l")]);
        assert_eq!(
            default_id(&entries, &settings(), Os::Linux).as_deref(),
            Some("login")
        );
        // fish is optional
        fake.files.remove(&PathBuf::from("/usr/bin/fish"));
        assert_eq!(ids(&discover(&fake, &settings())), ["login", "bash"]);
    }

    #[cfg(unix)]
    #[test]
    fn unix_ignores_a_login_shell_that_does_not_exist_or_is_relative() {
        for shell in ["/nope/bash", "bash"] {
            let mut fake = Fake {
                os: Some(Os::Mac),
                ..Default::default()
            };
            fake.env.insert("SHELL".into(), shell.into());
            fake.files.insert(PathBuf::from("/bin/bash"));
            let entries = discover(&fake, &settings());
            assert_eq!(ids(&entries), ["bash"], "{shell}");
        }
        let mut bare = Fake::default();
        bare.files.insert(PathBuf::from("/bin/sh"));
        assert_eq!(ids(&discover(&bare, &settings())), ["sh"]);
    }

    #[cfg(windows)]
    #[test]
    fn custom_profiles_need_an_absolute_existing_executable() {
        let mut fake = Fake::windows().file(PathBuf::from("C:\\tools\\nu.exe"));
        fake.files.insert(PathBuf::from("C:\\tools\\other.exe"));
        let s = TerminalSettings {
            custom_profiles: vec![
                CustomShell {
                    id: "nu".into(),
                    name: "Nushell".into(),
                    program: "C:\\tools\\nu.exe".into(),
                    args: vec!["--login".into()],
                },
                CustomShell {
                    id: "rel".into(),
                    name: "Relative".into(),
                    program: "nu.exe".into(),
                    args: vec![],
                },
                CustomShell {
                    id: "missing".into(),
                    name: "Missing".into(),
                    program: "C:\\tools\\missing.exe".into(),
                    args: vec![],
                },
            ],
            ..settings()
        };
        let entries = discover(&fake, &s);
        assert!(ids(&entries).contains(&"custom:nu"));
        assert!(!ids(&entries).contains(&"custom:rel"));
        assert!(!ids(&entries).contains(&"custom:missing"));
        let nu = entries
            .iter()
            .find(|e| e.profile.id == "custom:nu")
            .unwrap();
        assert_eq!(nu.spec.args, vec![OsString::from("--login")]);
    }

    #[test]
    fn a_start_directory_becomes_a_working_directory_or_a_separate_wsl_argument() {
        let local = Spec {
            program: "sh".into(),
            args: vec![],
            kind: Kind::Local,
            wsl_distro: None,
        };
        let (spec, cwd) = with_start_dir(&local, Some(Path::new("/srv/it's a dir")));
        assert_eq!(spec, local, "arguments are untouched");
        assert_eq!(cwd.as_deref(), Some(Path::new("/srv/it's a dir")));
        let wsl = Spec {
            program: "wsl.exe".into(),
            args: vec!["-d".into(), "Ubuntu".into()],
            kind: Kind::Wsl,
            wsl_distro: Some("Ubuntu".into()),
        };
        let (spec, cwd) = with_start_dir(&wsl, Some(Path::new("C:\\Users\\me; calc")));
        assert_eq!(cwd, None);
        assert_eq!(
            spec.args,
            vec![
                OsString::from("-d"),
                OsString::from("Ubuntu"),
                OsString::from("--cd"),
                OsString::from("C:\\Users\\me; calc"), // one argument, never interpreted
            ]
        );
        assert_eq!(with_start_dir(&wsl, None).0, wsl);
    }
}
