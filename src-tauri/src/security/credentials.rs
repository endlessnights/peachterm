//! OS-native credential storage.
//!
//! * Windows: Credential Manager (`keyring` `windows-native`)
//! * macOS:   Keychain (`apple-native`)
//! * Linux:   Secret Service over D-Bus (`sync-secret-service`)
//!
//! There is **no plaintext fallback**. When the backend is unavailable the
//! store reports it and every write fails; the UI then disables "save
//! password" and connections prompt instead.

use super::secret::SecretString;
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

pub const SERVICE: &str = "dev.peachterm.app";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub available: bool,
    pub backend: &'static str,
    pub detail: Option<String>,
}

/// Storage for secrets keyed by an opaque account string.
/// `get` is for Rust-internal use only; no IPC command exposes it.
pub trait CredentialStore: Send + Sync {
    fn status(&self) -> CredentialStatus;
    fn set(&self, account: &str, secret: &SecretString) -> AppResult<()>;
    #[allow(dead_code)] // consumed by the SSH service in Phase 2
    fn get(&self, account: &str) -> AppResult<Option<SecretString>>;
    /// Deleting a missing entry is not an error.
    fn delete(&self, account: &str) -> AppResult<()>;
}

pub fn connection_account(connection_id: &uuid::Uuid) -> String {
    format!("connection:{connection_id}")
}

// ---------------------------------------------------------------------------
// keyring-backed implementation
// ---------------------------------------------------------------------------

pub struct KeyringCredentialStore {
    service: String,
    status: OnceLock<CredentialStatus>,
}

impl KeyringCredentialStore {
    pub fn new() -> Self {
        Self {
            service: SERVICE.to_owned(),
            status: OnceLock::new(),
        }
    }

    fn backend_name() -> &'static str {
        if cfg!(target_os = "windows") {
            "Windows Credential Manager"
        } else if cfg!(target_os = "macos") {
            "macOS Keychain"
        } else {
            "Secret Service"
        }
    }

    fn entry(&self, account: &str) -> AppResult<keyring::Entry> {
        keyring::Entry::new(&self.service, account).map_err(map_keyring_error)
    }

    fn ensure_available(&self) -> AppResult<()> {
        let status = self.status();
        if status.available {
            Ok(())
        } else {
            Err(AppError::CredentialsUnavailable(
                status.detail.unwrap_or_else(|| status.backend.to_owned()),
            ))
        }
    }
}

impl Default for KeyringCredentialStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Fixed vocabulary for logs: keyring error text may embed platform details.
fn keyring_error_kind(error: &keyring::Error) -> &'static str {
    match error {
        keyring::Error::PlatformFailure(_) => "platform_failure",
        keyring::Error::NoStorageAccess(_) => "no_storage_access",
        keyring::Error::NoEntry => "no_entry",
        keyring::Error::BadEncoding(_) => "bad_encoding",
        keyring::Error::TooLong(_, _) => "too_long",
        keyring::Error::Invalid(_, _) => "invalid",
        keyring::Error::Ambiguous(_) => "ambiguous",
        _ => "other",
    }
}

fn map_keyring_error(error: keyring::Error) -> AppError {
    match error {
        keyring::Error::PlatformFailure(e) => AppError::CredentialsUnavailable(e.to_string()),
        keyring::Error::NoStorageAccess(e) => AppError::CredentialsUnavailable(e.to_string()),
        // Other variants describe the request, never the secret value.
        other => AppError::Credentials(other.to_string()),
    }
}

impl CredentialStore for KeyringCredentialStore {
    fn status(&self) -> CredentialStatus {
        self.status
            .get_or_init(|| {
                // Probe with a lookup of an entry that never exists. `NoEntry`
                // proves the backend answered; anything else means it is not
                // usable (e.g. no Secret Service daemon on a headless Linux).
                let probe = keyring::Entry::new(&self.service, "__peachterm_probe__")
                    .and_then(|entry| entry.get_password());
                match probe {
                    Ok(_) | Err(keyring::Error::NoEntry) => CredentialStatus {
                        available: true,
                        backend: Self::backend_name(),
                        detail: None,
                    },
                    Err(error) => {
                        tracing::warn!(
                            event = "credentials.unavailable",
                            backend = "keychain",
                            error_kind = keyring_error_kind(&error),
                        );
                        CredentialStatus {
                            available: false,
                            backend: Self::backend_name(),
                            detail: Some(error.to_string()),
                        }
                    }
                }
            })
            .clone()
    }

    fn set(&self, account: &str, secret: &SecretString) -> AppResult<()> {
        self.ensure_available()?;
        self.entry(account)?
            .set_password(secret.expose())
            .map_err(map_keyring_error)
    }

    fn get(&self, account: &str) -> AppResult<Option<SecretString>> {
        self.ensure_available()?;
        match self.entry(account)?.get_password() {
            Ok(value) => Ok(Some(SecretString::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    fn delete(&self, account: &str) -> AppResult<()> {
        if !self.status().available {
            // Nothing could have been stored.
            return Ok(());
        }
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(map_keyring_error(error)),
        }
    }
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests and explicit "unavailable" simulation)
// ---------------------------------------------------------------------------

#[allow(dead_code)] // used by unit tests and future integration harnesses
pub struct MemoryCredentialStore {
    available: bool,
    entries: Mutex<HashMap<String, String>>,
}

#[allow(dead_code)]
impl MemoryCredentialStore {
    pub fn new() -> Self {
        Self {
            available: true,
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub fn unavailable() -> Self {
        Self {
            available: false,
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.lock().map(|e| e.len()).unwrap_or(0)
    }
}

impl CredentialStore for MemoryCredentialStore {
    fn status(&self) -> CredentialStatus {
        CredentialStatus {
            available: self.available,
            backend: "memory",
            detail: (!self.available).then(|| "simulated unavailable backend".to_owned()),
        }
    }

    fn set(&self, account: &str, secret: &SecretString) -> AppResult<()> {
        if !self.available {
            return Err(AppError::CredentialsUnavailable("memory".into()));
        }
        self.entries
            .lock()
            .map_err(|_| AppError::Credentials("lock poisoned".into()))?
            .insert(account.to_owned(), secret.expose().to_owned());
        Ok(())
    }

    fn get(&self, account: &str) -> AppResult<Option<SecretString>> {
        if !self.available {
            return Err(AppError::CredentialsUnavailable("memory".into()));
        }
        Ok(self
            .entries
            .lock()
            .map_err(|_| AppError::Credentials("lock poisoned".into()))?
            .get(account)
            .cloned()
            .map(SecretString::new))
    }

    fn delete(&self, account: &str) -> AppResult<()> {
        self.entries
            .lock()
            .map_err(|_| AppError::Credentials("lock poisoned".into()))?
            .remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_set_get_delete() {
        let store = MemoryCredentialStore::new();
        let account = connection_account(&uuid::Uuid::new_v4());
        assert!(store.get(&account).unwrap().is_none());
        store
            .set(&account, &SecretString::new("pw".into()))
            .unwrap();
        assert_eq!(store.get(&account).unwrap().unwrap().expose(), "pw");
        store.delete(&account).unwrap();
        store.delete(&account).unwrap();
        assert!(store.get(&account).unwrap().is_none());
    }

    #[test]
    fn unavailable_store_refuses_writes_instead_of_falling_back() {
        let store = MemoryCredentialStore::unavailable();
        assert!(!store.status().available);
        let err = store
            .set("connection:x", &SecretString::new("pw".into()))
            .unwrap_err();
        assert_eq!(err.code(), "credentials_unavailable");
        assert_eq!(store.len(), 0);
    }

    #[test]
    fn errors_do_not_contain_secret() {
        let store = MemoryCredentialStore::unavailable();
        let err = store
            .set("connection:x", &SecretString::new("TopSecret!".into()))
            .unwrap_err();
        assert!(!err.to_string().contains("TopSecret!"));
    }
}
