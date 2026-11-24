// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! `tunnels.json`: saved tunnel definitions, per saved connection. Contains
//! names, addresses and ports only: no credentials, no running state.

use super::model::{TunnelDef, TunnelInput, build, revalidate};
use crate::error::{AppError, AppResult};
use crate::storage::atomic::{ConfigIssue, file_label, load_json_value, save_json};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use uuid::Uuid;

/// A saved connection may carry this many tunnels (keeps the dialog usable).
pub const MAX_PER_CONNECTION: usize = 32;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Doc {
    version: u32,
    tunnels: Vec<TunnelDef>,
}

pub struct TunnelStore {
    path: PathBuf,
    doc: Mutex<Doc>,
    issues: Vec<ConfigIssue>,
}

impl TunnelStore {
    pub fn open(path: PathBuf) -> AppResult<Self> {
        let mut issues = Vec::new();
        let mut doc = Doc {
            version: 1,
            tunnels: Vec::new(),
        };
        if let Some(Value::Object(map)) = load_json_value(&path, &mut issues) {
            let mut skipped = false;
            if let Some(Value::Array(entries)) = map.get("tunnels") {
                for entry in entries {
                    match serde_json::from_value::<TunnelDef>(entry.clone())
                        .ok()
                        .and_then(|d| revalidate(&d))
                    {
                        Some(def) if !doc.tunnels.iter().any(|t| t.id == def.id) => {
                            doc.tunnels.push(def);
                        }
                        _ => skipped = true,
                    }
                }
            }
            if skipped {
                issues.push(ConfigIssue {
                    file: file_label(&path),
                    kind: "invalid_entries",
                    field: None,
                    backed_up: false,
                });
            }
        }
        Ok(Self {
            path,
            doc: Mutex::new(doc),
            issues,
        })
    }

    pub fn issues(&self) -> &[ConfigIssue] {
        &self.issues
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, Doc>> {
        self.doc
            .lock()
            .map_err(|_| AppError::Storage("tunnel store lock poisoned".into()))
    }

    pub fn for_connection(&self, connection_id: Uuid) -> AppResult<Vec<TunnelDef>> {
        Ok(self
            .lock()?
            .tunnels
            .iter()
            .filter(|t| t.connection_id == connection_id)
            .cloned()
            .collect())
    }

    pub fn get(&self, id: Uuid) -> AppResult<TunnelDef> {
        self.lock()?
            .tunnels
            .iter()
            .find(|t| t.id == id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("tunnel".into()))
    }

    /// Create (`input.id == None`) or update. Two saved tunnels never share a
    /// local endpoint, so a double start cannot be configured by accident.
    pub fn save(&self, connection_id: Uuid, input: TunnelInput) -> AppResult<TunnelDef> {
        let mut doc = self.lock()?;
        let id = input.id.unwrap_or_else(Uuid::new_v4);
        let existing = doc.tunnels.iter().position(|t| t.id == id);
        if let Some(i) = existing {
            if doc.tunnels[i].connection_id != connection_id {
                return Err(AppError::NotFound("tunnel".into()));
            }
        } else if input.id.is_some() {
            return Err(AppError::NotFound("tunnel".into()));
        } else if doc
            .tunnels
            .iter()
            .filter(|t| t.connection_id == connection_id)
            .count()
            >= MAX_PER_CONNECTION
        {
            return Err(AppError::Validation(format!(
                "A connection can have at most {MAX_PER_CONNECTION} tunnels."
            )));
        }
        let def = build(input, connection_id, id)?;
        if let Some(other) = doc.tunnels.iter().find(|t| {
            t.id != id && t.bind_address == def.bind_address && t.local_port == def.local_port
        }) {
            return Err(AppError::Validation(format!(
                "The local port {} is already used by the tunnel \"{}\".",
                def.local_port, other.name
            )));
        }
        let mut next = doc.tunnels.clone();
        match existing {
            Some(i) => next[i] = def.clone(),
            None => next.push(def.clone()),
        }
        persist(&self.path, &next)?;
        doc.tunnels = next;
        Ok(def)
    }

    pub fn delete(&self, id: Uuid) -> AppResult<()> {
        let mut doc = self.lock()?;
        let next: Vec<TunnelDef> = doc.tunnels.iter().filter(|t| t.id != id).cloned().collect();
        if next.len() == doc.tunnels.len() {
            return Err(AppError::NotFound("tunnel".into()));
        }
        persist(&self.path, &next)?;
        doc.tunnels = next;
        Ok(())
    }

    /// A deleted connection takes its tunnel definitions with it.
    pub fn delete_for_connection(&self, connection_id: Uuid) -> AppResult<()> {
        let mut doc = self.lock()?;
        let next: Vec<TunnelDef> = doc
            .tunnels
            .iter()
            .filter(|t| t.connection_id != connection_id)
            .cloned()
            .collect();
        if next.len() != doc.tunnels.len() {
            persist(&self.path, &next)?;
            doc.tunnels = next;
        }
        Ok(())
    }
}

fn persist(path: &std::path::Path, tunnels: &[TunnelDef]) -> AppResult<()> {
    save_json(
        path,
        &Doc {
            version: 1,
            tunnels: tunnels.to_vec(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str, port: u32) -> TunnelInput {
        TunnelInput {
            id: None,
            name: name.into(),
            bind_address: "127.0.0.1".into(),
            local_port: port,
            remote_host: "127.0.0.1".into(),
            remote_port: 3000,
            auto_start: false,
        }
    }

    #[test]
    fn definitions_survive_a_restart_and_hold_no_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tunnels.json");
        let conn = Uuid::new_v4();
        let saved = {
            let store = TunnelStore::open(path.clone()).unwrap();
            store.save(conn, input("Grafana", 8080)).unwrap()
        };
        let reopened = TunnelStore::open(path.clone()).unwrap();
        assert_eq!(reopened.for_connection(conn).unwrap(), vec![saved]);
        let text = std::fs::read_to_string(&path).unwrap().to_lowercase();
        for forbidden in ["password", "secret", "passphrase", "running", "status"] {
            assert!(!text.contains(forbidden), "{forbidden}");
        }
    }

    #[test]
    fn local_endpoints_are_unique_and_edits_keep_the_id() {
        let dir = tempfile::tempdir().unwrap();
        let store = TunnelStore::open(dir.path().join("t.json")).unwrap();
        let a = Uuid::new_v4();
        let first = store.save(a, input("A", 8080)).unwrap();
        let err = store.save(Uuid::new_v4(), input("B", 8080)).unwrap_err();
        assert!(err.to_string().contains("already used"), "{err}");
        let mut edit = input("A2", 9090);
        edit.id = Some(first.id);
        let edited = store.save(a, edit).unwrap();
        assert_eq!(edited.id, first.id);
        assert_eq!(store.for_connection(a).unwrap().len(), 1);
        // another connection cannot edit it
        let mut steal = input("X", 9091);
        steal.id = Some(first.id);
        assert_eq!(
            store.save(Uuid::new_v4(), steal).unwrap_err().code(),
            "not_found"
        );
    }

    #[test]
    fn invalid_entries_in_a_hand_edited_file_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.json");
        let good = Uuid::new_v4();
        std::fs::write(
            &path,
            format!(
                r#"{{"version":1,"tunnels":[
                  {{"id":"{good}","connectionId":"{good}","kind":"local","name":"ok","bindAddress":"127.0.0.1","localPort":1234,"remoteHost":"h","remotePort":22,"autoStart":false}},
                  {{"id":"{}","connectionId":"{good}","kind":"local","name":"evil","bindAddress":"0.0.0.0","localPort":1235,"remoteHost":"h","remotePort":22,"autoStart":true}},
                  {{"nonsense":true}}
                ]}}"#,
                Uuid::new_v4()
            ),
        )
        .unwrap();
        let store = TunnelStore::open(path).unwrap();
        let all = store.for_connection(good).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "ok");
        assert_eq!(store.issues().len(), 1);
    }

    #[test]
    fn deleting_works_and_a_connection_takes_its_tunnels_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = TunnelStore::open(dir.path().join("t.json")).unwrap();
        let c = Uuid::new_v4();
        let t = store.save(c, input("A", 8080)).unwrap();
        store.save(c, input("B", 8081)).unwrap();
        store.delete(t.id).unwrap();
        assert_eq!(store.delete(t.id).unwrap_err().code(), "not_found");
        store.delete_for_connection(c).unwrap();
        assert!(store.for_connection(c).unwrap().is_empty());
    }
}
