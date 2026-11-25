// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Application error type shared by services and IPC commands.
//!
//! Messages are composed from fixed strings plus non-sensitive context
//! (identifiers, host names). Secrets must never be formatted into an error.

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Validation(String),
    #[error("{0} was not found")]
    NotFound(String),
    #[error("storage error: {0}")]
    Storage(String),
    #[error("secure credential storage is unavailable: {0}")]
    CredentialsUnavailable(String),
    #[error("credential storage error: {0}")]
    Credentials(String),
    #[error("PeachTerm is locked")]
    Locked,
    #[error("{0} is not implemented yet")]
    NotImplemented(&'static str),
    /// A failure on the remote side or while transferring; `(token, sentence)`.
    #[error("{1}")]
    Remote(&'static str, &'static str),
    /// A user-facing error with a stable `key` the renderer localizes (the
    /// English `message` stays as the diagnostic text and as the fallback).
    /// `code` is the family it belongs to (`validation` or `storage`).
    #[error("{message}")]
    Keyed {
        code: &'static str,
        key: &'static str,
        message: String,
        params: Vec<(&'static str, String)>,
    },
}

impl AppError {
    /// A validation failure with a localizable key (see `src/i18n/errors.ts`).
    pub fn validation_key(key: &'static str, message: impl Into<String>) -> Self {
        AppError::Keyed {
            code: "validation",
            key,
            message: message.into(),
            params: Vec::new(),
        }
    }

    /// A storage failure with a localizable key.
    pub fn storage_key(key: &'static str, message: impl Into<String>) -> Self {
        AppError::Keyed {
            code: "storage",
            key,
            message: message.into(),
            params: Vec::new(),
        }
    }

    /// Adds a non-sensitive parameter (a count, a limit) used by the localized text.
    #[must_use]
    pub fn with_param(mut self, name: &'static str, value: impl ToString) -> Self {
        if let AppError::Keyed { params, .. } = &mut self {
            params.push((name, value.to_string()));
        }
        self
    }

    /// Errors meant to be shown to the user as they are (as opposed to wrapped
    /// into a generic storage failure by callers that roll back).
    pub fn is_validation(&self) -> bool {
        matches!(
            self,
            AppError::Validation(_)
                | AppError::Keyed {
                    code: "validation",
                    ..
                }
        )
    }

    /// Stable machine-readable code for the renderer.
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Validation(_) => "validation",
            AppError::NotFound(_) => "not_found",
            AppError::Storage(_) => "storage",
            AppError::CredentialsUnavailable(_) => "credentials_unavailable",
            AppError::Credentials(_) => "credentials",
            AppError::Locked => "locked",
            AppError::NotImplemented(_) => "not_implemented",
            AppError::Remote(..) => "remote",
            AppError::Keyed { code, .. } => code,
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        AppError::Storage(error.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        AppError::Storage(format!("invalid data file: {error}"))
    }
}

/// Wire format: `{ "code", "message" }` plus, when the renderer can localize it,
/// `"key"` (and `"params"`), or `"token"` for remote/transfer failures.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("code", self.code())?;
        map.serialize_entry("message", &self.to_string())?;
        match self {
            AppError::Remote(token, _) => map.serialize_entry("token", token)?,
            AppError::Keyed { key, params, .. } => {
                map.serialize_entry("key", key)?;
                if !params.is_empty() {
                    let object: std::collections::BTreeMap<&str, &str> =
                        params.iter().map(|(k, v)| (*k, v.as_str())).collect();
                    map.serialize_entry("params", &object)?;
                }
            }
            _ => {}
        }
        map.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_code_and_message() {
        let json = serde_json::to_value(AppError::NotFound("connection x".into())).unwrap();
        assert_eq!(json["code"], "not_found");
        assert_eq!(json["message"], "connection x was not found");
        assert!(json.get("key").is_none());
    }

    #[test]
    fn keyed_errors_carry_a_key_and_parameters() {
        let error = AppError::validation_key("lock.minLength", "too short").with_param("min", 8);
        assert!(error.is_validation());
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(json["code"], "validation");
        assert_eq!(json["message"], "too short");
        assert_eq!(json["key"], "lock.minLength");
        assert_eq!(json["params"]["min"], "8");
    }

    #[test]
    fn remote_errors_expose_their_token() {
        let json = serde_json::to_value(AppError::Remote("not_found", "No such file")).unwrap();
        assert_eq!(json["code"], "remote");
        assert_eq!(json["token"], "not_found");
    }
}
