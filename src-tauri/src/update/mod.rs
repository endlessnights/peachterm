// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! In-app updates through the official Tauri updater plugin.
//!
//! * The plugin downloads a static `latest.json` published with the GitHub
//!   Release and verifies the package signature (minisign) against the public key
//!   built into the application. Verification cannot be switched off here.
//! * Nothing is installed without the user: checking, downloading and installing
//!   are separate steps and installing is always an explicit click.
//! * No identifiers, no analytics: the only request is the `latest.json` GET.
//!
//! This is NOT Windows Authenticode or Apple notarisation (see docs/updates.md).

use crate::storage::atomic::{load_json_value, save_json};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri_plugin_updater::Update;

/// Fixed project page for release notes (the version is validated before use).
const RELEASES_URL: &str = "https://github.com/endlessnights/peachterm/releases";

/// How a release on offer relates to the installed version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Newer,
    SameOrOlder,
    /// A pre-release while the channel is stable-only.
    PrereleaseIgnored,
    Invalid,
}

/// Release policy: only strictly newer versions are offered (no downgrades), and
/// pre-releases (`0.4.0-beta.1`) only when the channel allows them. Stable only
/// for v0.3.0: `releases/latest` never lists a pre-release (see docs/updates.md).
pub fn judge(current: &str, offered: &str, allow_prerelease: bool) -> Verdict {
    let (Ok(current), Ok(offered)) = (Version::parse(current), Version::parse(offered)) else {
        return Verdict::Invalid;
    };
    if !offered.pre.is_empty() && !allow_prerelease {
        return Verdict::PrereleaseIgnored;
    }
    if offered > current {
        Verdict::Newer
    } else {
        Verdict::SameOrOlder
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Platform {
    Windows,
    Macos,
    LinuxAppimage,
    /// `.deb` or any other Linux install: updated through the package source / manually.
    LinuxPackage,
}

impl Platform {
    pub fn detect() -> Self {
        Self::detect_with(std::env::var_os("APPIMAGE").is_some())
    }

    pub fn detect_with(appimage: bool) -> Self {
        if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else if appimage {
            Self::LinuxAppimage
        } else {
            Self::LinuxPackage
        }
    }

    /// Whether PeachTerm may download and install an update in place. A `.deb`
    /// install is deliberately excluded: replacing a system package would need
    /// administrator rights, which the application does not request.
    pub fn can_install(self) -> bool {
        !matches!(self, Self::LinuxPackage)
    }
}

/// Fixed vocabulary for failures; the UI turns these into sentences and never
/// shows raw error text unless the user asks for details.
pub fn classify(error: &tauri_plugin_updater::Error) -> &'static str {
    use tauri_plugin_updater::Error as E;
    match error {
        E::Reqwest(e) if e.is_timeout() => "timeout",
        E::Reqwest(_) | E::Network(_) => "network",
        E::ReleaseNotFound | E::TargetNotFound(_) | E::TargetsNotFound(_) => "no_package",
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) => "signature",
        E::Serialization(_) | E::Semver(_) | E::UrlParse(_) | E::EmptyEndpoints => "bad_metadata",
        _ => "failed",
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Doc {
    version: u32,
    /// Unix seconds of the last check that reached the update source.
    last_check_at: Option<u64>,
}

/// What PeachTerm remembers about updates: one timestamp. Nothing else is stored.
pub struct UpdateService {
    path: PathBuf,
    last_check_at: Mutex<Option<u64>>,
    /// Set when the updater plugin is registered (a public key is built in).
    configured: AtomicBool,
    checking: AtomicBool,
    pending: Mutex<Option<Update>>,
    downloaded: Mutex<Option<Vec<u8>>>,
}

impl UpdateService {
    pub fn open(path: PathBuf) -> Self {
        let mut issues = Vec::new();
        let last = match load_json_value(&path, &mut issues) {
            Some(value) => serde_json::from_value::<Doc>(value)
                .ok()
                .and_then(|d| d.last_check_at),
            None => None,
        };
        Self {
            path,
            last_check_at: Mutex::new(last),
            configured: AtomicBool::new(false),
            checking: AtomicBool::new(false),
            pending: Mutex::new(None),
            downloaded: Mutex::new(None),
        }
    }

    pub fn set_configured(&self, yes: bool) {
        self.configured.store(yes, Ordering::SeqCst);
    }

    pub fn configured(&self) -> bool {
        self.configured.load(Ordering::SeqCst)
    }

    pub fn last_check_at(&self) -> Option<u64> {
        self.last_check_at.lock().ok().and_then(|g| *g)
    }

    pub fn record_check(&self, at: u64) {
        if let Ok(mut slot) = self.last_check_at.lock() {
            *slot = Some(at);
        }
        let _ = save_json(
            &self.path,
            &Doc {
                version: 1,
                last_check_at: Some(at),
            },
        );
    }

    /// Only one check runs at a time; `None` = one is already in progress.
    pub fn begin_check(&self) -> Option<CheckGuard<'_>> {
        self.checking
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| CheckGuard(&self.checking))
    }

    pub fn set_pending(&self, update: Option<Update>) {
        if let Ok(mut slot) = self.pending.lock() {
            *slot = update;
        }
        if let Ok(mut bytes) = self.downloaded.lock() {
            *bytes = None;
        }
    }

    pub fn pending(&self) -> Option<Update> {
        self.pending.lock().ok().and_then(|g| g.clone())
    }

    pub fn set_downloaded(&self, bytes: Vec<u8>) {
        if let Ok(mut slot) = self.downloaded.lock() {
            *slot = Some(bytes);
        }
    }

    pub fn has_downloaded(&self) -> bool {
        self.downloaded.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    pub fn take_downloaded(&self) -> Option<Vec<u8>> {
        self.downloaded.lock().ok().and_then(|mut g| g.take())
    }
}

pub struct CheckGuard<'a>(&'a AtomicBool);

impl Drop for CheckGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// The release-notes page of a version (`vX.Y.Z` tag), or the releases overview
/// when the version is not a plain semantic version.
pub fn notes_url(version: &str) -> String {
    match Version::parse(version) {
        Ok(v) => format!("{RELEASES_URL}/tag/v{v}"),
        Err(_) => RELEASES_URL.to_owned(),
    }
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_strictly_newer_stable_versions_are_offered() {
        assert_eq!(judge("0.3.0", "0.3.1", false), Verdict::Newer);
        assert_eq!(
            judge("0.3.0", "0.10.0", false),
            Verdict::Newer,
            "numeric, not text"
        );
        assert_eq!(judge("0.3.0", "1.0.0", false), Verdict::Newer);
        assert_eq!(judge("0.3.0", "0.3.0", false), Verdict::SameOrOlder);
        assert_eq!(
            judge("0.3.1", "0.3.0", false),
            Verdict::SameOrOlder,
            "no downgrade"
        );
        assert_eq!(judge("0.10.0", "0.9.0", false), Verdict::SameOrOlder);
    }

    #[test]
    fn prereleases_are_ignored_unless_the_channel_allows_them() {
        assert_eq!(
            judge("0.3.0", "0.4.0-beta.1", false),
            Verdict::PrereleaseIgnored
        );
        assert_eq!(judge("0.3.0", "0.4.0-beta.1", true), Verdict::Newer);
        // a pre-release of the SAME version sorts below the release: not an update
        assert_eq!(judge("0.3.0", "0.3.0-rc.1", true), Verdict::SameOrOlder);
        // a beta user is offered the final release
        assert_eq!(judge("0.4.0-beta.1", "0.4.0", false), Verdict::Newer);
    }

    #[test]
    fn garbage_versions_are_invalid_not_offered() {
        for bad in ["", "latest", "1", "1.2", "v1.2.3", "1.2.3.4", "<script>"] {
            assert_eq!(judge("0.3.0", bad, false), Verdict::Invalid, "{bad}");
        }
        assert_eq!(judge("nonsense", "0.3.1", false), Verdict::Invalid);
    }

    #[test]
    fn installing_in_place_is_not_offered_for_deb_or_other_linux_installs() {
        assert!(!Platform::LinuxPackage.can_install());
        assert!(Platform::LinuxAppimage.can_install());
        assert!(Platform::Windows.can_install());
        assert!(Platform::Macos.can_install());
        if cfg!(target_os = "linux") {
            assert_eq!(Platform::detect_with(true), Platform::LinuxAppimage);
            assert_eq!(Platform::detect_with(false), Platform::LinuxPackage);
        }
    }

    #[test]
    fn release_notes_links_are_built_from_validated_versions_only() {
        assert_eq!(
            notes_url("0.3.1"),
            "https://github.com/endlessnights/peachterm/releases/tag/v0.3.1"
        );
        for evil in ["../../x", "1.0.0/../../evil", "javascript:alert(1)", ""] {
            assert_eq!(notes_url(evil), RELEASES_URL, "{evil}");
        }
    }

    #[test]
    fn checks_never_overlap_and_only_a_timestamp_is_remembered() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("updates.json");
        let service = UpdateService::open(path.clone());
        assert!(service.last_check_at().is_none());
        {
            let first = service.begin_check();
            assert!(first.is_some());
            assert!(service.begin_check().is_none(), "no overlapping checks");
        }
        assert!(service.begin_check().is_some(), "released after the check");
        service.record_check(1_700_000_000);
        let reopened = UpdateService::open(path.clone());
        assert_eq!(reopened.last_check_at(), Some(1_700_000_000));
        let text = std::fs::read_to_string(&path).unwrap();
        let keys: Vec<String> = serde_json::from_str::<serde_json::Value>(&text)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(keys.len(), 2, "version + lastCheckAt only: {keys:?}");
    }

    #[test]
    fn failures_map_to_fixed_tokens() {
        use tauri_plugin_updater::Error as E;
        assert_eq!(classify(&E::ReleaseNotFound), "no_package");
        assert_eq!(classify(&E::TargetNotFound("x".into())), "no_package");
        assert_eq!(classify(&E::Network("dns".into())), "network");
        assert_eq!(classify(&E::EmptyEndpoints), "bad_metadata");
        assert_eq!(classify(&E::SignatureUtf8("x".into())), "signature");
        assert_eq!(classify(&E::BinaryNotFoundInArchive), "failed");
    }
}
