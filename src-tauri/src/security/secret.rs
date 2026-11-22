// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! A string that is wiped from memory on drop and never printed.

use serde::{Deserialize, Deserializer};
use zeroize::Zeroizing;

pub struct SecretString(Zeroizing<String>);

impl SecretString {
    pub fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }

    /// Explicit, greppable access to the plaintext.
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl std::fmt::Debug for SecretString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretString([redacted])")
    }
}

/// Deserialize-only: secrets can arrive over IPC but can never be serialized
/// back out (there is deliberately no `Serialize` impl).
impl<'de> Deserialize<'de> for SecretString {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer).map(SecretString::new)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_is_redacted() {
        let secret = SecretString::new("hunter2".into());
        assert_eq!(format!("{secret:?}"), "SecretString([redacted])");
        assert_eq!(secret.expose(), "hunter2");
    }
}
