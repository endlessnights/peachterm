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
    #[error("{0} is not implemented yet")]
    NotImplemented(&'static str),
}

impl AppError {
    /// Stable machine-readable code for the renderer.
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Validation(_) => "validation",
            AppError::NotFound(_) => "not_found",
            AppError::Storage(_) => "storage",
            AppError::CredentialsUnavailable(_) => "credentials_unavailable",
            AppError::Credentials(_) => "credentials",
            AppError::NotImplemented(_) => "not_implemented",
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

/// Wire format: `{ "code": "...", "message": "..." }`.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
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
    }
}
