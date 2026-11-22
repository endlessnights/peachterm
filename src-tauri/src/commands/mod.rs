//! Thin IPC adapters. No business logic lives here: commands deserialize,
//! call a service and map errors. Every command is `async` so it runs on the
//! async runtime instead of blocking the main (UI) thread.

pub mod app;
pub mod connections;
pub mod logging;
pub mod security;
pub mod settings;
pub mod window;

use crate::error::{AppError, AppResult};

/// Run potentially blocking work (keychain/D-Bus calls) off the async workers.
pub(crate) async fn blocking<T, F>(f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Storage(format!("background task failed: {e}")))?
}
