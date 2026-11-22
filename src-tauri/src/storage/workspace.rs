// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

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

/// The old two-pane split (read for upgrading; never written any more).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Orientation {
    /// Panes side by side.
    #[default]
    Vertical,
    /// Panes stacked.
    Horizontal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TabKind {
    #[default]
    Ssh,
    Local,
    Wsl,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTab {
    #[serde(default)]
    pub kind: TabKind,
    /// The saved connection (SSH tabs).
    #[serde(default)]
    pub connection_id: Option<Uuid>,
    /// The shell profile (local and WSL tabs): an id, never a command line.
    #[serde(default)]
    pub profile_id: Option<String>,
    /// Custom title only; `None` follows the default name.
    pub title: Option<String>,
    /// Terminal palette chosen for this tab only (a built-in preset id);
    /// `None` follows the global setting. Appearance only, nothing sensitive.
    #[serde(default)]
    pub colors: Option<String>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Dir {
    /// Side by side.
    Row,
    /// Stacked.
    Column,
}

/// The split tree: at most [`MAX_PANES`] panes, each showing one tab.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SavedNode {
    Leaf {
        /// Index into `tabs`.
        tab: usize,
    },
    Branch {
        dir: Dir,
        ratio: f64,
        a: Box<SavedNode>,
        b: Box<SavedNode>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Layout {
    pub tabs: Vec<SavedTab>,
    pub active: Option<usize>,
    /// Legacy two-pane split from older versions; converted to `tree`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub split: Option<SavedSplit>,
    pub tree: Option<SavedNode>,
    /// The tab shown in the focused pane.
    pub focus: Option<usize>,
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

pub const MAX_PANES: usize = 6;
const MAX_DEPTH: usize = 6;
pub const MIN_NODE_RATIO: f64 = 0.1;
pub const MAX_NODE_RATIO: f64 = 0.9;

fn profile_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

fn collect_tabs(node: &SavedNode, out: &mut Vec<usize>) {
    match node {
        SavedNode::Leaf { tab } => out.push(*tab),
        SavedNode::Branch { a, b, .. } => {
            collect_tabs(a, out);
            collect_tabs(b, out);
        }
    }
}

fn depth(node: &SavedNode) -> usize {
    match node {
        SavedNode::Leaf { .. } => 1,
        SavedNode::Branch { a, b, .. } => 1 + depth(a).max(depth(b)),
    }
}

fn clamp_ratios(node: SavedNode) -> SavedNode {
    match node {
        SavedNode::Leaf { .. } => node,
        SavedNode::Branch { dir, ratio, a, b } => SavedNode::Branch {
            dir,
            ratio: if ratio.is_finite() {
                ratio.clamp(MIN_NODE_RATIO, MAX_NODE_RATIO)
            } else {
                0.5
            },
            a: Box::new(clamp_ratios(*a)),
            b: Box::new(clamp_ratios(*b)),
        },
    }
}

/// Make any layout safe to store and to restore: bounded, consistent indexes,
/// clamped ratios, cleaned titles, valid tab descriptions.
pub fn sanitize_layout(mut layout: Layout) -> Layout {
    layout.tabs.truncate(MAX_TABS);
    for tab in &mut layout.tabs {
        tab.title = tab.title.as_deref().and_then(clean_title);
        tab.colors = tab
            .colors
            .take()
            .filter(|id| crate::storage::settings::is_terminal_preset(id));
        match tab.kind {
            TabKind::Ssh => tab.profile_id = None,
            TabKind::Local | TabKind::Wsl => {
                tab.connection_id = None;
                if !tab.profile_id.as_deref().is_some_and(profile_id_ok) {
                    tab.profile_id = None;
                }
            }
        }
    }
    let count = layout.tabs.len();
    layout.active = layout.active.filter(|&i| i < count);
    layout.focus = layout.focus.filter(|&i| i < count);

    // upgrade the old two-pane split
    if layout.tree.is_none()
        && let Some(split) = layout.split.take()
        && split.panes[0] < count
        && split.panes[1] < count
        && split.panes[0] != split.panes[1]
    {
        layout.tree = Some(SavedNode::Branch {
            dir: match split.orientation {
                Orientation::Vertical => Dir::Row,
                Orientation::Horizontal => Dir::Column,
            },
            ratio: split.ratio,
            a: Box::new(SavedNode::Leaf {
                tab: split.panes[0],
            }),
            b: Box::new(SavedNode::Leaf {
                tab: split.panes[1],
            }),
        });
        layout.focus = Some(split.panes[split.focus.min(1)]);
    }
    layout.split = None;

    layout.tree = layout.tree.take().and_then(|tree| {
        let mut tabs = Vec::new();
        collect_tabs(&tree, &mut tabs);
        let unique = tabs.iter().collect::<HashSet<_>>().len() == tabs.len();
        let valid = tabs.len() >= 2
            && tabs.len() <= MAX_PANES
            && unique
            && tabs.iter().all(|&t| t < count)
            && depth(&tree) <= MAX_DEPTH;
        valid.then(|| clamp_ratios(tree))
    });
    if layout.tree.is_none() {
        layout.focus = None;
    }
    layout
}

fn prune(node: SavedNode, map: &[Option<usize>]) -> Option<SavedNode> {
    match node {
        SavedNode::Leaf { tab } => map
            .get(tab)
            .copied()
            .flatten()
            .map(|tab| SavedNode::Leaf { tab }),
        SavedNode::Branch { dir, ratio, a, b } => match (prune(*a, map), prune(*b, map)) {
            (Some(a), Some(b)) => Some(SavedNode::Branch {
                dir,
                ratio,
                a: Box::new(a),
                b: Box::new(b),
            }),
            (Some(only), None) | (None, Some(only)) => Some(only),
            (None, None) => None,
        },
    }
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

/// Keep only tabs that can still be restored: SSH tabs whose saved connection
/// exists, and every local or WSL tab. Indexes are remapped; a pane whose tab
/// disappeared collapses (a tree reduced to one pane is no split).
pub fn retain_existing(layout: Layout, exists: &HashSet<Uuid>) -> Layout {
    let mut map = vec![None; layout.tabs.len()];
    let mut tabs = Vec::new();
    for (old, tab) in layout.tabs.into_iter().enumerate() {
        let keep = match tab.kind {
            TabKind::Ssh => tab.connection_id.is_some_and(|id| exists.contains(&id)),
            TabKind::Local | TabKind::Wsl => tab.profile_id.is_some(),
        };
        if keep {
            map[old] = Some(tabs.len());
            tabs.push(tab);
        }
    }
    let tree = layout.tree.and_then(|t| prune(t, &map)).filter(|t| {
        let mut shown = Vec::new();
        collect_tabs(t, &mut shown);
        shown.len() >= 2
    });
    Layout {
        active: layout.active.and_then(|i| map[i]),
        focus: if tree.is_some() {
            layout.focus.and_then(|i| map[i])
        } else {
            None
        },
        split: None,
        tree,
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

    fn ssh(n: u128, title: Option<&str>) -> SavedTab {
        SavedTab {
            kind: TabKind::Ssh,
            connection_id: Some(id(n)),
            profile_id: None,
            title: title.map(str::to_owned),
            colors: None,
        }
    }

    fn local(profile: &str) -> SavedTab {
        SavedTab {
            kind: TabKind::Local,
            connection_id: None,
            profile_id: Some(profile.into()),
            title: None,
            colors: None,
        }
    }

    fn leaf(tab: usize) -> Box<SavedNode> {
        Box::new(SavedNode::Leaf { tab })
    }

    fn branch(dir: Dir, ratio: f64, a: Box<SavedNode>, b: Box<SavedNode>) -> Box<SavedNode> {
        Box::new(SavedNode::Branch { dir, ratio, a, b })
    }

    /// ┌───┬───┐
    /// │ 0 │ 1 │   a mixed, nested layout of three panes
    /// │   ├───┤
    /// │   │ 2 │
    /// └───┴───┘
    fn layout() -> Layout {
        Layout {
            tabs: vec![ssh(1, Some("prod web")), ssh(2, None), local("pwsh")],
            active: Some(2),
            split: None,
            tree: Some(*branch(
                Dir::Row,
                0.4,
                leaf(0),
                branch(Dir::Column, 0.3, leaf(1), leaf(2)),
            )),
            focus: Some(1),
        }
    }

    #[test]
    fn a_nested_layout_round_trips_through_the_file() {
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
            "password", "secret", "token", "session", "policy", "command", "yes",
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
        assert!(
            value["layout"].get("split").is_none(),
            "the legacy field is not written"
        );
    }

    #[test]
    fn up_to_six_panes_are_kept_and_more_are_refused() {
        let six = |n: usize| {
            let mut node = leaf(0);
            for i in 1..n {
                node = branch(Dir::Row, 0.5, node, leaf(i));
            }
            Layout {
                tabs: (0..n).map(|i| ssh(i as u128 + 1, None)).collect(),
                tree: Some(*node),
                ..Default::default()
            }
        };
        for n in 2..=6 {
            assert!(sanitize_layout(six(n)).tree.is_some(), "{n} panes");
        }
        assert!(
            sanitize_layout(six(7)).tree.is_none(),
            "7 panes are refused"
        );
        assert!(
            sanitize_layout(six(1)).tree.is_none(),
            "one pane is no split"
        );
    }

    #[test]
    fn invalid_trees_are_dropped_not_repaired_into_something_else() {
        let mut l = layout();
        l.tree = Some(*branch(Dir::Row, 0.5, leaf(0), leaf(0))); // same tab twice
        assert!(sanitize_layout(l).tree.is_none());
        let mut l = layout();
        l.tree = Some(*branch(Dir::Row, 0.5, leaf(0), leaf(9))); // out of range
        assert!(sanitize_layout(l).tree.is_none());
        let mut l = layout();
        l.tree = Some(*branch(Dir::Row, f64::NAN, leaf(0), leaf(1)));
        let fixed = sanitize_layout(l).tree.unwrap();
        assert!(matches!(fixed, SavedNode::Branch { ratio, .. } if ratio == 0.5));
        let mut l = layout();
        l.tree = Some(*branch(Dir::Row, 0.99, leaf(0), leaf(1)));
        assert!(
            matches!(sanitize_layout(l).tree, Some(SavedNode::Branch { ratio, .. }) if ratio == MAX_NODE_RATIO)
        );
        // depth bomb: a chain of 40 splits
        let mut deep = leaf(0);
        for _ in 0..40 {
            deep = branch(Dir::Column, 0.5, deep, leaf(1));
        }
        let l = Layout {
            tabs: vec![ssh(1, None), ssh(2, None)],
            tree: Some(*deep),
            ..Default::default()
        };
        assert!(sanitize_layout(l).tree.is_none());
    }

    #[test]
    fn hostile_titles_profiles_and_indexes_are_made_safe() {
        let mut l = layout();
        l.tabs[0].title = Some(format!("a\nb\u{7}{}", "x".repeat(500)));
        l.tabs[2].profile_id = Some("rm -rf /; echo".into()); // not an id
        l.active = Some(99);
        l.focus = Some(77);
        let safe = sanitize_layout(l);
        let title = safe.tabs[0].title.clone().unwrap();
        assert!(title.starts_with("a b "));
        assert_eq!(title.chars().count(), MAX_TITLE_CHARS);
        assert_eq!(safe.tabs[2].profile_id, None);
        assert_eq!((safe.active, safe.focus), (None, None));
        let many = Layout {
            tabs: (0..500).map(|n| ssh(n, None)).collect(),
            ..Default::default()
        };
        assert_eq!(sanitize_layout(many).tabs.len(), MAX_TABS);
        // an SSH tab cannot smuggle a profile and a local tab cannot name a server
        let mut l = layout();
        l.tabs[0].profile_id = Some("pwsh".into());
        l.tabs[2].connection_id = Some(id(5));
        let safe = sanitize_layout(l);
        assert_eq!(safe.tabs[0].profile_id, None);
        assert_eq!(safe.tabs[2].connection_id, None);
    }

    #[test]
    fn the_old_two_pane_split_is_upgraded() {
        let legacy = Layout {
            tabs: vec![ssh(1, None), ssh(2, None)],
            active: Some(1),
            split: Some(SavedSplit {
                orientation: Orientation::Horizontal,
                ratio: 0.3,
                panes: [0, 1],
                focus: 1,
            }),
            tree: None,
            focus: None,
        };
        let upgraded = sanitize_layout(legacy);
        assert_eq!(upgraded.split, None);
        assert_eq!(
            upgraded.tree,
            Some(*branch(Dir::Column, 0.3, leaf(0), leaf(1)))
        );
        assert_eq!(upgraded.focus, Some(1));

        // and straight from an old file
        let old = r#"{"tabs":[{"connectionId":"00000000-0000-0000-0000-000000000001","title":null},
            {"connectionId":"00000000-0000-0000-0000-000000000002","title":"two"}],
            "active":0,"split":{"orientation":"vertical","ratio":0.5,"panes":[0,1],"focus":0}}"#;
        let parsed: Layout = serde_json::from_str(old).unwrap();
        let upgraded = sanitize_layout(parsed);
        assert!(upgraded.tree.is_some());
        assert_eq!(upgraded.tabs[0].kind, TabKind::Ssh);
        assert_eq!(upgraded.tabs[1].title.as_deref(), Some("two"));
    }

    #[test]
    fn tabs_that_cannot_be_restored_drop_out_and_the_tree_collapses() {
        // connection 2 was deleted: its pane goes, the others stay side by side
        let restored = retain_existing(layout(), &all(&[1]));
        assert_eq!(restored.tabs.len(), 2); // ssh(1) and the local shell
        assert_eq!(restored.active, Some(1));
        assert_eq!(
            restored.tree,
            Some(*branch(Dir::Row, 0.4, leaf(0), leaf(1)))
        );
        assert_eq!(restored.focus, None, "the focused tab was deleted");
        // only one pane left: no split
        let one = retain_existing(layout(), &all(&[]));
        assert_eq!(one.tabs.len(), 1);
        assert!(one.tree.is_none());
        assert_eq!(one.focus, None);
    }

    #[test]
    fn recent_sessions_are_ordered_newest_first_without_duplicates() {
        let (_dir, s) = store();
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
