// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Saved tunnel definitions and their validation.
//!
//! A definition says *what* to forward; whether it is running is never stored
//! (see `engine`). Definitions hold no credentials. `kind` exists so remote
//! (`-R`) and dynamic (`-D`) forwarding can be added later without a format
//! change; only `local` is implemented.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use uuid::Uuid;

pub const MAX_NAME: usize = 64;
pub const MAX_HOST: usize = 253;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TunnelKind {
    /// `ssh -L`: a local listener whose connections are carried to a remote destination.
    #[default]
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelDef {
    pub id: Uuid,
    /// The saved SSH connection this tunnel belongs to.
    pub connection_id: Uuid,
    #[serde(default)]
    pub kind: TunnelKind,
    pub name: String,
    /// Loopback address the listener binds to (`127.0.0.1` or `::1`).
    pub bind_address: String,
    pub local_port: u16,
    /// Reached from the SSH server's point of view (its own `127.0.0.1` is the server's loopback).
    pub remote_host: String,
    pub remote_port: u16,
    #[serde(default)]
    pub auto_start: bool,
}

/// What the renderer may send. `id: None` creates a tunnel.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInput {
    pub id: Option<Uuid>,
    pub name: String,
    #[serde(default = "default_bind")]
    pub bind_address: String,
    pub local_port: u32,
    pub remote_host: String,
    pub remote_port: u32,
    #[serde(default)]
    pub auto_start: bool,
}

fn default_bind() -> String {
    "127.0.0.1".into()
}

fn port(value: u32, what: &str) -> AppResult<u16> {
    u16::try_from(value)
        .ok()
        .filter(|p| *p >= 1)
        .ok_or_else(|| AppError::Validation(format!("{what} must be between 1 and 65535.")))
}

/// Letters, digits, hyphens and dots; labels of 1-63 characters that do not
/// start or end with a hyphen. No spaces or control characters can get through.
fn valid_hostname(host: &str) -> bool {
    let host = host.strip_suffix('.').unwrap_or(host);
    !host.is_empty()
        && host.len() <= MAX_HOST
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

/// Normalise the remote destination: IPv4, IPv6 (brackets allowed) or hostname.
pub fn clean_remote_host(text: &str) -> AppResult<String> {
    let trimmed = text.trim();
    let bare = trimmed
        .strip_prefix('[')
        .and_then(|t| t.strip_suffix(']'))
        .unwrap_or(trimmed);
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return Ok(ip.to_string());
    }
    if valid_hostname(trimmed) {
        return Ok(trimmed.to_ascii_lowercase());
    }
    Err(AppError::Validation(
        "The remote destination must be an IP address or a host name.".into(),
    ))
}

/// Only loopback addresses are accepted: a tunnel must not become reachable
/// from the network (see docs/tunnels.md).
pub fn clean_bind(text: &str) -> AppResult<String> {
    match text.trim().parse::<IpAddr>() {
        Ok(ip) if ip.is_loopback() => Ok(ip.to_string()),
        _ => Err(AppError::Validation(
            "Tunnels can only listen on a loopback address (127.0.0.1 or ::1).".into(),
        )),
    }
}

/// Validate user input into a definition for `connection_id`.
pub fn build(input: TunnelInput, connection_id: Uuid, id: Uuid) -> AppResult<TunnelDef> {
    let name: String = input.name.trim().chars().take(MAX_NAME + 1).collect();
    if name.is_empty() {
        return Err(AppError::Validation("Give the tunnel a name.".into()));
    }
    if name.chars().count() > MAX_NAME || name.chars().any(char::is_control) {
        return Err(AppError::Validation(format!(
            "The name can have at most {MAX_NAME} characters and no control characters."
        )));
    }
    Ok(TunnelDef {
        id,
        connection_id,
        kind: TunnelKind::Local,
        name,
        bind_address: clean_bind(&input.bind_address)?,
        local_port: port(input.local_port, "The local port")?,
        remote_host: clean_remote_host(&input.remote_host)?,
        remote_port: port(input.remote_port, "The remote port")?,
        auto_start: input.auto_start,
    })
}

/// Re-check a definition read from disk (a hand-edited file must not be able
/// to open a listener on a non-loopback address).
pub fn revalidate(def: &TunnelDef) -> Option<TunnelDef> {
    build(
        TunnelInput {
            id: Some(def.id),
            name: def.name.clone(),
            bind_address: def.bind_address.clone(),
            local_port: u32::from(def.local_port),
            remote_host: def.remote_host.clone(),
            remote_port: u32::from(def.remote_port),
            auto_start: def.auto_start,
        },
        def.connection_id,
        def.id,
    )
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> TunnelInput {
        TunnelInput {
            id: None,
            name: "Grafana".into(),
            bind_address: "127.0.0.1".into(),
            local_port: 8080,
            remote_host: "127.0.0.1".into(),
            remote_port: 3000,
            auto_start: false,
        }
    }

    fn make(i: TunnelInput) -> AppResult<TunnelDef> {
        build(i, Uuid::new_v4(), Uuid::new_v4())
    }

    #[test]
    fn a_normal_definition_is_accepted_and_defaults_are_safe() {
        let def = make(input()).unwrap();
        assert_eq!(def.bind_address, "127.0.0.1");
        assert_eq!((def.local_port, def.remote_port), (8080, 3000));
        assert!(!def.auto_start);
        assert_eq!(def.kind, TunnelKind::Local);
    }

    #[test]
    fn only_loopback_may_be_listened_on() {
        for bad in ["0.0.0.0", "::", "192.168.1.5", "example.com", ""] {
            let mut i = input();
            i.bind_address = bad.into();
            assert!(make(i).is_err(), "{bad}");
        }
        let mut i = input();
        i.bind_address = "::1".into();
        assert_eq!(make(i).unwrap().bind_address, "::1");
    }

    #[test]
    fn ports_must_be_in_range() {
        for bad in [0u32, 65536, 1_000_000] {
            let mut i = input();
            i.local_port = bad;
            assert!(make(i).is_err());
            let mut i = input();
            i.remote_port = bad;
            assert!(make(i).is_err());
        }
        let mut i = input();
        i.local_port = 65535;
        assert!(make(i).is_ok());
    }

    #[test]
    fn remote_destinations_support_ipv4_ipv6_and_hostnames_only() {
        for good in [
            "10.0.0.5",
            "::1",
            "[2001:db8::1]",
            "db.internal",
            "Grafana-1",
            "a.b.c.",
        ] {
            assert!(clean_remote_host(good).is_ok(), "{good}");
        }
        for bad in [
            "", " ", "a b", "a;b", "$(id)", "-x.com", "x..com", "a/b", "h\nost", "ho$t",
        ] {
            assert!(clean_remote_host(bad).is_err(), "{bad:?}");
        }
        assert_eq!(clean_remote_host("[2001:db8::1]").unwrap(), "2001:db8::1");
        assert_eq!(clean_remote_host("DB.Internal").unwrap(), "db.internal");
    }

    #[test]
    fn names_are_trimmed_and_bounded() {
        let mut i = input();
        i.name = "  ".into();
        assert!(make(i).is_err());
        let mut i = input();
        i.name = "x".repeat(MAX_NAME + 1);
        assert!(make(i).is_err());
        let mut i = input();
        i.name = "bad\u{7}name".into();
        assert!(make(i).is_err());
        let mut i = input();
        i.name = "  Grafana  ".into();
        assert_eq!(make(i).unwrap().name, "Grafana");
    }

    #[test]
    fn a_hand_edited_non_loopback_definition_is_rejected_on_load() {
        let mut def = make(input()).unwrap();
        def.bind_address = "0.0.0.0".into();
        assert!(revalidate(&def).is_none());
    }
}
