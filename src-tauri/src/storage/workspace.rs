//! Workspace layout and recent-session history (`workspace.json`).
//!
//! Only metadata is stored: which saved connection each tab belongs to, an
//! optional custom tab title, the order, the split layout, and a list of recent
//! saved connection ids. Never a password, a key, a session id, terminal
//! content, a command, or an upload permission (those live in memory only and
//! start at `AlwaysAsk` for every new SSH session).

use super::atomic::{ConfigIssue, ensure_backup, file_label, load_json_value, save_json};
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use uuid::Uuid;

pub const MAX_TABS: usize = 100;
pub const MAX_RECENT: usize = 20;
pub const MAX_TITLE_CHARS: usize = 128;
pub const MIN_RATIO: f64 = 0.15;
pub const MAX_RATIO: f64 = 0.85;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Orientation {
    /// Panes side by side.
    #[default]
    Vertical,
    /// Panes stacked.
    Horizontal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTab {
    pub connection_id: Uuid,
    /// Custom title only; `None` follows the saved connection's name.
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSplit {
    pub orientation: Orientation,
    pub ratio: f64,
    /// Indexes into `tabs`; two different tabs.
    pub panes: [usize; 2],
    pub focus: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Layout {
    pub tabs: Vec<SavedTab>,
    pub active: Option<usize>,
    pub split: Option<SavedSplit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub connection_id: Uuid,
    /// Seconds since the Unix epoch (informational; the list order is what counts).
    pub at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Doc {
    version: u32,
    layout: Layout,
    recent: Vec<RecentEntry>,
}

pub fn clean_title(title: &str) -> Option<String> {
    let cleaned: String = title
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let trimmed: String = cleaned.trim().chars().take(MAX_TITLE_CHARS).collect();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// Make any layout safe to store and to restore: bounded, consistent indexes,
/// clamped ratio, cleaned titles.
pub fn sanitize_layout(mut layout: Layout) -> Layout {
    layout.tabs.truncate(MAX_TABS);
    for tab in &mut layout.tabs {
        tab.title = tab.title.as_deref().and_then(clean_title);
    }
    let count = layout.tabs.len();
    layout.active = layout.active.filter(|&i| i < count);
    layout.split = layout.split.and_then(|mut s| {
        let valid = s.panes[0] < count && s.panes[1] < count && s.panes[0] != s.panes[1];
        if !valid {
            return None;
        }
        s.ratio = if s.ratio.is_finite() {
            s.ratio.clamp(MIN_RATIO, MAX_RATIO)
        } else {
            0.5
        };
        s.focus = s.focus.min(1);
        Some(s)
    });
    layout
}

/// What may be stored: the layout when tab restoration is on, otherwise
/// nothing at all about the open tabs (titles, order and splits are not kept).
pub fn layout_to_keep(restore_tabs: bool, layout: Layout) -> Layout {
    if restore_tabs {
        layout
    } else {
        Layout::default()
    }
}

/// Keep only tabs whose saved connection still exists, remapping the indexes
/// (a split whose pane disappeared is dropped).
pub fn retain_existing(layout: Layout, exists: &HashSet<Uuid>) -> Layout {
    let mut map = vec![None; layout.tabs.len()];
    let mut tabs = Vec::new();
    for (old, tab) in layout.tabs.into_iter().enumerate() {
        if exists.contains(&tab.connection_id) {
            map[old] = Some(tabs.len());
            tabs.push(tab);
        }
    }
    Layout {
        active: layout.active.and_then(|i| map[i]),
        split: layout.split.and_then(|s| {
            Some(SavedSplit {
                panes: [map[s.panes[0]]?, map[s.panes[1]]?],
                ..s
            })
        }),
        tabs,
    }
}

pub struct WorkspaceStore {
    path: PathBuf,
    doc: Mutex<Doc>,
    issues: Vec<ConfigIssue>,
}

impl WorkspaceStore {
    pub fn open(path: PathBuf) -> AppResult<Self> {
        let mut issues = Vec::new();
        let mut doc = Doc::default();
        match load_json_value(&path, &mut issues) {
            Some(value @ Value::Object(_)) => match serde_json::from_value::<Doc>(value) {
                Ok(parsed) => doc = parsed,
                Err(_) => {
                    issues.push(ConfigIssue {
                        file: file_label(&path),
                        kind: "invalid_value",
                        field: None,
                        backed_up: false,
                    });
                    let at = issues.len() - 1;
                    ensure_backup(&path, &mut issues, at);
                }
            },
            Some(_) => {
                issues.push(ConfigIssue {
                    file: file_label(&path),
                    kind: "not_an_object",
                    field: None,
                    backed_up: false,
                });
                let at = issues.len() - 1;
                ensure_backup(&path, &mut issues, at);
            }
            None => {}
        }
        doc.version = 1;
        doc.layout = sanitize_layout(doc.layout);
        doc.recent = dedupe(doc.recent);
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
            .map_err(|_| AppError::Storage("workspace lock poisoned".into()))
    }

    fn persist(&self, doc: &Doc) -> AppResult<()> {
        save_json(&self.path, doc)
    }

    pub fn layout(&self) -> AppResult<Layout> {
        Ok(self.lock()?.layout.clone())
    }

    pub fn save_layout(&self, layout: Layout) -> AppResult<()> {
        let mut doc = self.lock()?;
        let layout = sanitize_layout(layout);
        if doc.layout == layout {
            return Ok(());
        }
        doc.layout = layout;
        self.persist(&doc)
    }

    /// A saved connection authenticated successfully: it becomes the newest
    /// entry; any older entry for the same id is removed (never duplicates).
    pub fn record_recent(&self, connection_id: Uuid, at: u64) -> AppResult<()> {
        let mut doc = self.lock()?;
        doc.recent.retain(|e| e.connection_id != connection_id);
        doc.recent.insert(0, RecentEntry { connection_id, at });
        doc.recent.truncate(MAX_RECENT);
        self.persist(&doc)
    }

    /// Newest first, at most `limit`, only connections that still exist (the
    /// stored list is cleaned of deleted ones at the same time).
    pub fn recent(&self, limit: usize, exists: &HashSet<Uuid>) -> AppResult<Vec<Uuid>> {
        let mut doc = self.lock()?;
        let before = doc.recent.len();
        doc.recent.retain(|e| exists.contains(&e.connection_id));
        if doc.recent.len() != before {
            self.persist(&doc)?;
        }
        Ok(doc
            .recent
            .iter()
            .take(limit.clamp(1, MAX_RECENT))
            .map(|e| e.connection_id)
            .collect())
    }

    /// Clears only the history: saved connections, credentials and open
    /// sessions are not touched.
    pub fn clear_recent(&self) -> AppResult<()> {
        let mut doc = self.lock()?;
        if doc.recent.is_empty() {
            return Ok(());
        }
        doc.recent.clear();
        self.persist(&doc)
    }
}

fn dedupe(entries: Vec<RecentEntry>) -> Vec<RecentEntry> {
    let mut seen = HashSet::new();
    let mut out: Vec<RecentEntry> = entries
        .into_iter()
        .filter(|e| seen.insert(e.connection_id))
        .collect();
    out.truncate(MAX_RECENT);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, WorkspaceStore) {
        let dir = tempfile::tempdir().unwrap();
        let s = WorkspaceStore::open(dir.path().join("workspace.json")).unwrap();
        (dir, s)
    }

    fn id(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }

    fn all(ids: &[u128]) -> HashSet<Uuid> {
        ids.iter().map(|n| id(*n)).collect()
    }

    fn layout() -> Layout {
        Layout {
            tabs: vec![
                SavedTab {
                    connection_id: id(1),
                    title: Some("prod web".into()),
                },
                SavedTab {
                    connection_id: id(2),
                    title: None,
                },
                SavedTab {
                    connection_id: id(1),
                    title: None,
                },
            ],
            active: Some(2),
            split: Some(SavedSplit {
                orientation: Orientation::Horizontal,
                ratio: 0.3,
                panes: [0, 2],
                focus: 1,
            }),
        }
    }

    #[test]
    fn layout_round_trips_through_the_file() {
        let (dir, s) = store();
        s.save_layout(layout()).unwrap();
        let reopened = WorkspaceStore::open(dir.path().join("workspace.json")).unwrap();
        assert_eq!(reopened.layout().unwrap(), layout());
    }

    #[test]
    fn the_file_holds_metadata_only() {
        let (dir, s) = store();
        s.save_layout(layout()).unwrap();
        s.record_recent(id(1), 5).unwrap();
        let text = std::fs::read_to_string(dir.path().join("workspace.json")).unwrap();
        for forbidden in [
            "password", "secret", "token", "session", "policy", "yes", "ask",
        ] {
            assert!(
                !text.to_lowercase().contains(forbidden),
                "{forbidden} must not appear: {text}"
            );
        }
        let value: Value = serde_json::from_str(&text).unwrap();
        let mut keys: Vec<_> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["layout", "recent", "version"]);
    }

    #[test]
    fn hostile_layouts_are_made_safe() {
        let mut l = layout();
        l.tabs[0].title = Some(format!("a\nb\u{7}{}", "x".repeat(500)));
        l.active = Some(99);
        l.split = Some(SavedSplit {
            orientation: Orientation::Vertical,
            ratio: f64::NAN,
            panes: [0, 1],
            focus: 7,
        });
        let safe = sanitize_layout(l);
        let title = safe.tabs[0].title.clone().unwrap();
        assert!(title.starts_with("a b "));
        assert_eq!(title.chars().count(), MAX_TITLE_CHARS);
        assert_eq!(safe.active, None);
        let split = safe.split.unwrap();
        assert_eq!((split.ratio, split.focus), (0.5, 1));

        let mut l = layout();
        l.split.as_mut().unwrap().panes = [1, 1]; // the same tab twice
        assert!(sanitize_layout(l).split.is_none());
        let mut l = layout();
        l.split.as_mut().unwrap().panes = [0, 9];
        assert!(sanitize_layout(l).split.is_none());
        let mut l = layout();
        l.split.as_mut().unwrap().ratio = 0.99;
        assert_eq!(sanitize_layout(l).split.unwrap().ratio, MAX_RATIO);

        let many = Layout {
            tabs: (0..500)
                .map(|n| SavedTab {
                    connection_id: id(n),
                    title: None,
                })
                .collect(),
            ..Default::default()
        };
        assert_eq!(sanitize_layout(many).tabs.len(), MAX_TABS);
    }

    #[test]
    fn deleted_connections_drop_out_of_a_restored_layout() {
        let restored = retain_existing(layout(), &all(&[1])); // connection 2 was deleted
        assert_eq!(restored.tabs.len(), 2);
        assert_eq!(restored.active, Some(1));
        assert_eq!(restored.split.unwrap().panes, [0, 1]);
        let without_first = retain_existing(layout(), &all(&[2]));
        assert_eq!(without_first.tabs.len(), 1);
        assert!(
            without_first.split.is_none(),
            "a split that lost a pane is dropped"
        );
        assert_eq!(without_first.active, None);
    }

    #[test]
    fn recent_sessions_are_ordered_newest_first_without_duplicates() {
        let (_dir, s) = store();
        // pve1, pve2, pve1, pve1, pve3
        for (n, who) in [1u128, 2, 1, 1, 3].into_iter().enumerate() {
            s.record_recent(id(who), n as u64).unwrap();
        }
        let ids = all(&[1, 2, 3]);
        assert_eq!(s.recent(10, &ids).unwrap(), [id(3), id(1), id(2)]);
        assert_eq!(s.recent(2, &ids).unwrap(), [id(3), id(1)]);
        assert_eq!(s.recent(0, &ids).unwrap().len(), 1, "limit is at least one");
    }

    #[test]
    fn the_history_is_bounded_and_survives_a_restart() {
        let (dir, s) = store();
        for n in 0..40u128 {
            s.record_recent(id(n), n as u64).unwrap();
        }
        let ids: HashSet<Uuid> = (0..40).map(id).collect();
        let list = s.recent(100, &ids).unwrap();
        assert_eq!(list.len(), MAX_RECENT);
        assert_eq!(list[0], id(39));
        let reopened = WorkspaceStore::open(dir.path().join("workspace.json")).unwrap();
        assert_eq!(reopened.recent(100, &ids).unwrap(), list);
    }

    #[test]
    fn deleted_connections_are_removed_from_the_history() {
        let (dir, s) = store();
        for who in [1u128, 2, 3] {
            s.record_recent(id(who), 0).unwrap();
        }
        assert_eq!(s.recent(10, &all(&[1, 3])).unwrap(), [id(3), id(1)]);
        // gone from the file as well, not only hidden
        let reopened = WorkspaceStore::open(dir.path().join("workspace.json")).unwrap();
        assert_eq!(
            reopened.recent(10, &all(&[1, 2, 3])).unwrap(),
            [id(3), id(1)]
        );
    }

    #[test]
    fn clearing_the_history_keeps_the_layout() {
        let (dir, s) = store();
        s.save_layout(layout()).unwrap();
        s.record_recent(id(1), 0).unwrap();
        s.clear_recent().unwrap();
        assert!(s.recent(10, &all(&[1])).unwrap().is_empty());
        let reopened = WorkspaceStore::open(dir.path().join("workspace.json")).unwrap();
        assert!(reopened.recent(10, &all(&[1])).unwrap().is_empty());
        assert_eq!(reopened.layout().unwrap(), layout());
    }

    #[test]
    fn duplicate_entries_in_an_old_file_are_merged_when_loading() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        let a = id(1);
        let b = id(2);
        std::fs::write(
            &path,
            format!(
                r#"{{"version":1,"recent":[{{"connectionId":"{a}","at":3}},{{"connectionId":"{b}","at":2}},{{"connectionId":"{a}","at":1}}]}}"#
            ),
        )
        .unwrap();
        let s = WorkspaceStore::open(path).unwrap();
        assert_eq!(s.recent(10, &all(&[1, 2])).unwrap(), [a, b]);
    }

    #[test]
    fn a_damaged_file_starts_empty_and_keeps_a_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        std::fs::write(&path, b"{ not json").unwrap();
        let s = WorkspaceStore::open(path).unwrap();
        assert!(s.layout().unwrap().tabs.is_empty());
        assert_eq!(s.issues().len(), 1);
        assert!(s.issues()[0].backed_up);
    }

    #[test]
    fn nothing_about_tabs_is_kept_unless_restoring_is_on() {
        assert_eq!(layout_to_keep(true, layout()), layout());
        assert_eq!(layout_to_keep(false, layout()), Layout::default());
        let (dir, s) = store();
        s.save_layout(layout_to_keep(false, layout())).unwrap();
        let text = std::fs::read_to_string(dir.path().join("workspace.json")).unwrap_or_default();
        assert!(
            !text.contains("prod web"),
            "custom titles are not persisted: {text}"
        );
    }

    #[test]
    fn titles_are_cleaned() {
        assert_eq!(clean_title("  hi\tthere  ").as_deref(), Some("hi there"));
        assert_eq!(clean_title("   "), None);
        assert_eq!(clean_title("ünï ✓").as_deref(), Some("ünï ✓"));
    }
}
