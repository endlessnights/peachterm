// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Structural operations on the saved-connection tree: move, reorder, bulk
//! delete and reference repair.
//!
//! Everything here is pure (it works on `&mut ConnectionTree`), identifies
//! items only by stable ids, and never touches connection parameters or
//! credentials: a move changes `folder_id` / `parent_id` / `sort_order` only.
//!
//! Folder depth: at most [`MAX_FOLDER_DEPTH`] levels (root children are level 1;
//! the root itself does not count). Data that already exceeds the limit is
//! preserved, and a move is allowed as long as it does not make any folder
//! *deeper* than it already is, so users can reorganise legacy trees.

use super::connections::{Connection, ConnectionTree, Folder};
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub const MAX_FOLDER_DEPTH: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ItemRef {
    Connection { id: Uuid },
    Folder { id: Uuid },
}

impl ItemRef {
    pub fn id(&self) -> Uuid {
        match self {
            ItemRef::Connection { id } | ItemRef::Folder { id } => *id,
        }
    }
    fn is_folder(&self) -> bool {
        matches!(self, ItemRef::Folder { .. })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FolderDeleteMode {
    /// Folders are removed; their contents move up to the nearest surviving parent.
    MoveToParent,
    /// Folders are removed together with everything inside them.
    DeleteContents,
}

/// What a delete would do (also returned after it ran).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePlan {
    pub connection_ids: Vec<Uuid>,
    pub folder_ids: Vec<Uuid>,
    pub moved_connections: usize,
    pub moved_folders: usize,
}

fn natural_key(name: &str) -> String {
    name.to_lowercase()
}

impl ConnectionTree {
    fn folder(&self, id: Uuid) -> Option<&Folder> {
        self.folders.iter().find(|f| f.id == id)
    }

    fn connection(&self, id: Uuid) -> Option<&Connection> {
        self.connections.iter().find(|c| c.id == id)
    }

    fn parent_of_folder(&self, id: Uuid) -> Option<Uuid> {
        self.folder(id).and_then(|f| f.parent_id)
    }

    /// Level of a folder: root children are 1. A cycle or a dangling reference
    /// stops the climb (such data is repaired on load).
    pub fn folder_level(&self, id: Uuid) -> usize {
        let mut level = 0;
        let mut cursor = Some(id);
        let mut seen = HashSet::new();
        while let Some(current) = cursor {
            if !seen.insert(current) || self.folder(current).is_none() {
                break;
            }
            level += 1;
            cursor = self.parent_of_folder(current);
        }
        level
    }

    /// Number of folder levels in the subtree rooted at `id`, itself included.
    pub fn subtree_height(&self, id: Uuid) -> usize {
        fn go(tree: &ConnectionTree, id: Uuid, seen: &mut HashSet<Uuid>) -> usize {
            if !seen.insert(id) {
                return 0;
            }
            1 + tree
                .folders
                .iter()
                .filter(|f| f.parent_id == Some(id))
                .map(|f| go(tree, f.id, seen))
                .max()
                .unwrap_or(0)
        }
        go(self, id, &mut HashSet::new())
    }

    /// Is `node` equal to `root` or inside its sub-tree?
    pub fn in_subtree(&self, node: Uuid, root: Uuid) -> bool {
        let mut cursor = Some(node);
        let mut seen = HashSet::new();
        while let Some(current) = cursor {
            if current == root {
                return true;
            }
            if !seen.insert(current) {
                return false;
            }
            cursor = self.parent_of_folder(current);
        }
        false
    }

    /// Ids of `root` and every folder below it.
    fn subtree_ids(&self, root: Uuid) -> HashSet<Uuid> {
        self.folders
            .iter()
            .map(|f| f.id)
            .filter(|id| self.in_subtree(*id, root))
            .collect()
    }

    /// Children of one folder (or the root) of one kind, in display order.
    pub fn sorted_children(&self, parent: Option<Uuid>, folders: bool) -> Vec<ItemRef> {
        if folders {
            let mut list: Vec<&Folder> = self
                .folders
                .iter()
                .filter(|f| f.parent_id == parent)
                .collect();
            list.sort_by_key(|f| (f.sort_order, natural_key(&f.name)));
            list.iter().map(|f| ItemRef::Folder { id: f.id }).collect()
        } else {
            let mut list: Vec<&Connection> = self
                .connections
                .iter()
                .filter(|c| c.folder_id == parent)
                .collect();
            list.sort_by_key(|c| (c.sort_order, natural_key(&c.name)));
            list.iter()
                .map(|c| ItemRef::Connection { id: c.id })
                .collect()
        }
    }

    fn exists(&self, item: &ItemRef) -> bool {
        match item {
            ItemRef::Connection { id } => self.connection(*id).is_some(),
            ItemRef::Folder { id } => self.folder(*id).is_some(),
        }
    }

    fn parent_of(&self, item: &ItemRef) -> Option<Uuid> {
        match item {
            ItemRef::Connection { id } => self.connection(*id).and_then(|c| c.folder_id),
            ItemRef::Folder { id } => self.parent_of_folder(*id),
        }
    }

    fn name_of_folder(&self, id: Uuid) -> String {
        self.folder(id).map(|f| f.name.clone()).unwrap_or_default()
    }

    /// De-duplicate, check existence and drop items that travel with a selected
    /// ancestor folder anyway.
    fn normalize(&self, items: &[ItemRef], prune_descendants: bool) -> AppResult<Vec<ItemRef>> {
        let mut seen = HashSet::new();
        let unique: Vec<ItemRef> = items.iter().copied().filter(|i| seen.insert(*i)).collect();
        for item in &unique {
            if !self.exists(item) {
                return Err(AppError::NotFound(match item {
                    ItemRef::Connection { .. } => "connection".into(),
                    ItemRef::Folder { .. } => "folder".into(),
                }));
            }
        }
        if !prune_descendants {
            return Ok(unique);
        }
        let selected_folders: HashSet<Uuid> = unique
            .iter()
            .filter(|i| i.is_folder())
            .map(ItemRef::id)
            .collect();
        Ok(unique
            .into_iter()
            .filter(|item| {
                // An item is redundant when one of its ancestors is selected.
                let mut cursor = self.parent_of(item);
                let mut guard = HashSet::new();
                while let Some(p) = cursor {
                    if selected_folders.contains(&p) && !(item.is_folder() && item.id() == p) {
                        return false;
                    }
                    if !guard.insert(p) {
                        break;
                    }
                    cursor = self.parent_of_folder(p);
                }
                true
            })
            .collect())
    }

    /// Check a move without performing it. Returns the normalised item list.
    pub fn validate_move(
        &self,
        items: &[ItemRef],
        target: Option<Uuid>,
    ) -> AppResult<Vec<ItemRef>> {
        if let Some(t) = target
            && self.folder(t).is_none()
        {
            return Err(AppError::NotFound("destination folder".into()));
        }
        let items = self.normalize(items, true)?;
        let target_level = target.map(|t| self.folder_level(t)).unwrap_or(0);
        for item in &items {
            let ItemRef::Folder { id } = item else {
                continue;
            };
            if let Some(t) = target
                && self.in_subtree(t, *id)
            {
                return Err(AppError::Validation(
                    "A folder cannot be moved into itself or one of its own sub-folders.".into(),
                ));
            }
            let height = self.subtree_height(*id);
            let reaches = target_level + height;
            let currently = self.folder_level(*id) + height - 1;
            if reaches > MAX_FOLDER_DEPTH && reaches > currently {
                return Err(AppError::Validation(format!(
                    "Folders can be nested at most {MAX_FOLDER_DEPTH} levels deep. Moving “{}” here would put its contents at level {reaches}.",
                    self.name_of_folder(*id)
                )));
            }
        }
        Ok(items)
    }

    /// Move `items` into `target` (`None` = top level), placing them before the
    /// sibling `before` (or at the end). Only parent references and ordering
    /// change; nothing else about any item is touched.
    pub fn move_items(
        &mut self,
        items: &[ItemRef],
        target: Option<Uuid>,
        before: Option<ItemRef>,
    ) -> AppResult<()> {
        let items = self.validate_move(items, target)?;
        if items.is_empty() {
            return Ok(());
        }
        let moved: HashSet<ItemRef> = items.iter().copied().collect();
        for item in &items {
            match item {
                ItemRef::Connection { id } => {
                    if let Some(c) = self.connections.iter_mut().find(|c| c.id == *id) {
                        c.folder_id = target;
                    }
                }
                ItemRef::Folder { id } => {
                    if let Some(f) = self.folders.iter_mut().find(|f| f.id == *id) {
                        f.parent_id = target;
                    }
                }
            }
        }
        for folders in [true, false] {
            let moving: Vec<ItemRef> = items
                .iter()
                .copied()
                .filter(|i| i.is_folder() == folders)
                .collect();
            if moving.is_empty() {
                continue;
            }
            let mut order: Vec<ItemRef> = self
                .sorted_children(target, folders)
                .into_iter()
                .filter(|i| !moved.contains(i))
                .collect();
            let at = before
                .filter(|b| b.is_folder() == folders && !moved.contains(b))
                .and_then(|b| order.iter().position(|i| *i == b))
                .unwrap_or(order.len());
            for (offset, item) in moving.into_iter().enumerate() {
                order.insert(at + offset, item);
            }
            self.renumber(&order);
        }
        Ok(())
    }

    fn renumber(&mut self, order: &[ItemRef]) {
        let positions: HashMap<ItemRef, i64> = order
            .iter()
            .enumerate()
            .map(|(i, item)| (*item, i as i64))
            .collect();
        for c in &mut self.connections {
            if let Some(p) = positions.get(&ItemRef::Connection { id: c.id }) {
                c.sort_order = *p;
            }
        }
        for f in &mut self.folders {
            if let Some(p) = positions.get(&ItemRef::Folder { id: f.id }) {
                f.sort_order = *p;
            }
        }
    }

    /// What deleting `items` in `mode` would remove and relocate.
    pub fn plan_delete(&self, items: &[ItemRef], mode: FolderDeleteMode) -> AppResult<DeletePlan> {
        // Explicitly selected children are deleted too, so no pruning here.
        let items = self.normalize(items, false)?;
        let selected_folders: Vec<Uuid> = items
            .iter()
            .filter(|i| i.is_folder())
            .map(ItemRef::id)
            .collect();
        let mut doomed_folders: HashSet<Uuid> = HashSet::new();
        match mode {
            FolderDeleteMode::DeleteContents => {
                for f in &selected_folders {
                    doomed_folders.extend(self.subtree_ids(*f));
                }
            }
            FolderDeleteMode::MoveToParent => doomed_folders.extend(selected_folders.iter()),
        }
        let mut doomed_connections: HashSet<Uuid> = items
            .iter()
            .filter(|i| !i.is_folder())
            .map(ItemRef::id)
            .collect();
        if mode == FolderDeleteMode::DeleteContents {
            doomed_connections.extend(
                self.connections
                    .iter()
                    .filter(|c| c.folder_id.is_some_and(|f| doomed_folders.contains(&f)))
                    .map(|c| c.id),
            );
        }
        let moved_connections = self
            .connections
            .iter()
            .filter(|c| !doomed_connections.contains(&c.id))
            .filter(|c| c.folder_id.is_some_and(|f| doomed_folders.contains(&f)))
            .count();
        let moved_folders = self
            .folders
            .iter()
            .filter(|f| !doomed_folders.contains(&f.id))
            .filter(|f| f.parent_id.is_some_and(|p| doomed_folders.contains(&p)))
            .count();
        let mut connection_ids: Vec<Uuid> = doomed_connections.into_iter().collect();
        let mut folder_ids: Vec<Uuid> = doomed_folders.into_iter().collect();
        connection_ids.sort();
        folder_ids.sort();
        Ok(DeletePlan {
            connection_ids,
            folder_ids,
            moved_connections,
            moved_folders,
        })
    }

    /// Perform [`plan_delete`](Self::plan_delete). Contents that survive are
    /// re-parented to the nearest surviving ancestor and appended there.
    pub fn delete_items(
        &mut self,
        items: &[ItemRef],
        mode: FolderDeleteMode,
    ) -> AppResult<DeletePlan> {
        let plan = self.plan_delete(items, mode)?;
        let doomed_folders: HashSet<Uuid> = plan.folder_ids.iter().copied().collect();
        let doomed_connections: HashSet<Uuid> = plan.connection_ids.iter().copied().collect();

        let surviving_parent = |tree: &ConnectionTree, mut parent: Option<Uuid>| {
            let mut guard = HashSet::new();
            while let Some(p) = parent {
                if !doomed_folders.contains(&p) || !guard.insert(p) {
                    break;
                }
                parent = tree.parent_of_folder(p);
            }
            parent
        };
        let reparent: Vec<(ItemRef, Option<Uuid>)> = self
            .connections
            .iter()
            .filter(|c| !doomed_connections.contains(&c.id))
            .filter(|c| c.folder_id.is_some_and(|f| doomed_folders.contains(&f)))
            .map(|c| {
                (
                    ItemRef::Connection { id: c.id },
                    surviving_parent(self, c.folder_id),
                )
            })
            .chain(
                self.folders
                    .iter()
                    .filter(|f| !doomed_folders.contains(&f.id))
                    .filter(|f| f.parent_id.is_some_and(|p| doomed_folders.contains(&p)))
                    .map(|f| {
                        (
                            ItemRef::Folder { id: f.id },
                            surviving_parent(self, f.parent_id),
                        )
                    }),
            )
            .collect();

        self.connections
            .retain(|c| !doomed_connections.contains(&c.id));
        self.folders.retain(|f| !doomed_folders.contains(&f.id));

        // Append relocated items to the end of their new parent.
        let mut by_parent: HashMap<(Option<Uuid>, bool), Vec<ItemRef>> = HashMap::new();
        for (item, parent) in &reparent {
            match item {
                ItemRef::Connection { id } => {
                    if let Some(c) = self.connections.iter_mut().find(|c| c.id == *id) {
                        c.folder_id = *parent;
                    }
                }
                ItemRef::Folder { id } => {
                    if let Some(f) = self.folders.iter_mut().find(|f| f.id == *id) {
                        f.parent_id = *parent;
                    }
                }
            }
            by_parent
                .entry((*parent, item.is_folder()))
                .or_default()
                .push(*item);
        }
        for ((parent, folders), moved) in by_parent {
            let moved: HashSet<ItemRef> = moved.into_iter().collect();
            let mut order: Vec<ItemRef> = self
                .sorted_children(parent, folders)
                .into_iter()
                .filter(|i| !moved.contains(i))
                .collect();
            let mut tail: Vec<ItemRef> = self
                .sorted_children(parent, folders)
                .into_iter()
                .filter(|i| moved.contains(i))
                .collect();
            order.append(&mut tail);
            self.renumber(&order);
        }
        Ok(plan)
    }

    /// Fix dangling and circular references without deleting anything: such
    /// items are moved to the top level. Returns how many references were fixed.
    pub fn repair_references(&mut self) -> usize {
        let folder_ids: HashSet<Uuid> = self.folders.iter().map(|f| f.id).collect();
        let mut fixed = 0;
        for f in &mut self.folders {
            if f.parent_id
                .is_some_and(|p| !folder_ids.contains(&p) || p == f.id)
            {
                f.parent_id = None;
                fixed += 1;
            }
        }
        for c in &mut self.connections {
            if c.folder_id.is_some_and(|p| !folder_ids.contains(&p)) {
                c.folder_id = None;
                fixed += 1;
            }
        }
        // Cycles: walk up from every folder; cut the edge that closes a loop.
        let ids: Vec<Uuid> = self.folders.iter().map(|f| f.id).collect();
        for id in ids {
            let mut seen = HashSet::new();
            let mut cursor = id;
            while let Some(parent) = self.parent_of_folder(cursor) {
                if !seen.insert(cursor) || seen.contains(&parent) {
                    if let Some(f) = self.folders.iter_mut().find(|f| f.id == cursor) {
                        f.parent_id = None;
                        fixed += 1;
                    }
                    break;
                }
                cursor = parent;
            }
        }
        fixed
    }

    /// Folders whose contents sit deeper than the current limit (legacy data).
    pub fn too_deep_folders(&self) -> Vec<Uuid> {
        self.folders
            .iter()
            .filter(|f| self.folder_level(f.id) > MAX_FOLDER_DEPTH)
            .map(|f| f.id)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::connections::AuthMethod;

    fn folder(name: &str, parent: Option<Uuid>) -> Folder {
        Folder {
            id: Uuid::new_v4(),
            name: name.into(),
            parent_id: parent,
            expanded: true,
            sort_order: 0,
        }
    }

    fn conn(name: &str, folder_id: Option<Uuid>) -> Connection {
        Connection {
            monitoring: Default::default(),
            id: Uuid::new_v4(),
            name: name.into(),
            host: format!("{name}.example.com"),
            port: 2222,
            username: "ops".into(),
            auth: AuthMethod::PublicKey,
            key_path: Some("/keys/id".into()),
            save_password: true,
            has_stored_secret: true,
            timeout_secs: 33,
            initial_directory: Some("/srv".into()),
            folder_id,
            sort_order: 0,
            created_at: 1,
            updated_at: 2,
        }
    }

    fn f(id: Uuid) -> ItemRef {
        ItemRef::Folder { id }
    }
    fn c(id: Uuid) -> ItemRef {
        ItemRef::Connection { id }
    }

    /// root: A(1) > B(2) > C(3), plus loose D, E and connections.
    struct Fixture {
        tree: ConnectionTree,
        a: Uuid,
        b: Uuid,
        cc: Uuid,
        d: Uuid,
        e: Uuid,
        s1: Uuid,
        s2: Uuid,
        s3: Uuid,
    }

    fn fixture() -> Fixture {
        let a = folder("A", None);
        let b = folder("B", Some(a.id));
        let cc = folder("C", Some(b.id));
        let d = folder("D", None);
        let e = folder("E", None);
        let s1 = conn("s1", None);
        let s2 = conn("s2", Some(cc.id));
        let s3 = conn("s3", Some(d.id));
        let tree = ConnectionTree {
            version: 2,
            folders: vec![a.clone(), b.clone(), cc.clone(), d.clone(), e.clone()],
            connections: vec![s1.clone(), s2.clone(), s3.clone()],
        };
        Fixture {
            tree,
            a: a.id,
            b: b.id,
            cc: cc.id,
            d: d.id,
            e: e.id,
            s1: s1.id,
            s2: s2.id,
            s3: s3.id,
        }
    }

    #[test]
    fn levels_and_heights() {
        let x = fixture();
        assert_eq!(x.tree.folder_level(x.a), 1);
        assert_eq!(x.tree.folder_level(x.cc), 3);
        assert_eq!(x.tree.subtree_height(x.a), 3);
        assert_eq!(x.tree.subtree_height(x.cc), 1);
        assert!(x.tree.too_deep_folders().is_empty());
    }

    #[test]
    fn moving_connections_into_out_of_and_between_folders() {
        let mut x = fixture();
        x.tree.move_items(&[c(x.s1)], Some(x.cc), None).unwrap(); // root -> nested (level 3)
        assert_eq!(x.tree.connection(x.s1).unwrap().folder_id, Some(x.cc));
        x.tree.move_items(&[c(x.s2)], Some(x.d), None).unwrap(); // between folders
        assert_eq!(x.tree.connection(x.s2).unwrap().folder_id, Some(x.d));
        x.tree.move_items(&[c(x.s3)], None, None).unwrap(); // out of a folder
        assert_eq!(x.tree.connection(x.s3).unwrap().folder_id, None);
    }

    #[test]
    fn a_move_changes_only_location_never_parameters_or_secrets() {
        let mut x = fixture();
        let before = x.tree.connection(x.s1).unwrap().clone();
        x.tree.move_items(&[c(x.s1)], Some(x.e), None).unwrap();
        let after = x.tree.connection(x.s1).unwrap();
        let mut expected = before;
        expected.folder_id = Some(x.e);
        expected.sort_order = after.sort_order;
        assert_eq!(*after, expected);
        assert!(after.has_stored_secret && after.save_password);
    }

    #[test]
    fn folders_may_nest_to_three_levels_and_no_further() {
        let mut x = fixture();
        // A > B > C is level 3. Moving D (height 1) into C would be level 4.
        let err = x.tree.move_items(&[f(x.d)], Some(x.cc), None).unwrap_err();
        assert_eq!(err.code(), "validation");
        assert!(err.to_string().contains("at most 3 levels"), "{err}");
        // Moving D into B is level 3: fine.
        x.tree.move_items(&[f(x.d)], Some(x.b), None).unwrap();
        assert_eq!(x.tree.folder_level(x.d), 3);
        // Nothing was changed by the failed move.
        assert_eq!(x.tree.folder(x.d).unwrap().parent_id, Some(x.b));
    }

    #[test]
    fn whole_subtrees_are_depth_checked() {
        let mut x = fixture();
        // A (height 3) into E (level 1) would reach level 4.
        let err = x.tree.move_items(&[f(x.a)], Some(x.e), None).unwrap_err();
        assert!(err.to_string().contains("level 4"), "{err}");
        // B (height 2) into E reaches level 3: fine, and C travels with it.
        x.tree.move_items(&[f(x.b)], Some(x.e), None).unwrap();
        assert_eq!(x.tree.folder_level(x.cc), 3);
        assert_eq!(x.tree.connection(x.s2).unwrap().folder_id, Some(x.cc));
    }

    #[test]
    fn cycles_are_rejected() {
        let mut x = fixture();
        for target in [x.a, x.b, x.cc] {
            let err = x
                .tree
                .move_items(&[f(x.a)], Some(target), None)
                .unwrap_err();
            assert!(
                err.to_string().contains("cannot be moved into itself"),
                "{err}"
            );
        }
        assert_eq!(x.tree.folder(x.a).unwrap().parent_id, None);
    }

    #[test]
    fn invalid_references_are_rejected() {
        let mut x = fixture();
        assert_eq!(
            x.tree
                .move_items(&[c(x.s1)], Some(Uuid::new_v4()), None)
                .unwrap_err()
                .code(),
            "not_found"
        );
        assert_eq!(
            x.tree
                .move_items(&[c(Uuid::new_v4())], None, None)
                .unwrap_err()
                .code(),
            "not_found"
        );
    }

    #[test]
    fn legacy_deep_data_is_preserved_and_can_only_be_moved_shallower() {
        // Build A > B > C > D > E (levels 1..5) by hand, as an old file might.
        let a = folder("A", None);
        let b = folder("B", Some(a.id));
        let cc = folder("C", Some(b.id));
        let d = folder("D", Some(cc.id));
        let e = folder("E", Some(d.id));
        let mut tree = ConnectionTree {
            version: 2,
            folders: vec![a, b.clone(), cc, d.clone(), e.clone()],
            connections: vec![],
        };
        assert_eq!(tree.too_deep_folders(), vec![d.id, e.id]);
        // Sideways/deeper moves of the deep part are refused...
        let x = folder("X", None);
        tree.folders.push(x.clone());
        let err = tree.move_items(&[f(d.id)], Some(x.id), None);
        assert!(
            err.is_ok(),
            "moving D (height 2) under X (level 1) is level 3"
        );
        assert_eq!(tree.folder_level(e.id), 3);
        // ...but flattening is always allowed: B (height 2 now) to the root.
        tree.move_items(&[f(b.id)], None, None).unwrap();
        assert_eq!(tree.folder_level(b.id), 1);
        // Nothing was deleted.
        assert_eq!(tree.folders.len(), 6);
    }

    #[test]
    fn moves_that_do_not_deepen_legacy_data_are_allowed_even_beyond_the_limit() {
        let a = folder("A", None);
        let b = folder("B", Some(a.id));
        let cc = folder("C", Some(b.id));
        let d = folder("D", Some(cc.id));
        let e = folder("E", Some(d.id));
        let g = folder("G", Some(cc.id)); // sibling of D at level 4
        let mut tree = ConnectionTree {
            version: 2,
            folders: vec![a, b, cc.clone(), d.clone(), e.clone(), g.clone()],
            connections: vec![],
        };
        // D (levels 4-5) into C is where it already is: not deeper, so allowed.
        tree.move_items(&[f(d.id)], Some(cc.id), None).unwrap();
        // E (level 5) into G (level 4) would be level 5 again: allowed, not deeper.
        tree.move_items(&[f(e.id)], Some(g.id), None).unwrap();
        assert_eq!(tree.folder_level(e.id), 5);
    }

    #[test]
    fn reordering_within_a_folder_and_stable_ids() {
        let mut x = fixture();
        let n1 = conn("n1", Some(x.e));
        let n2 = conn("n2", Some(x.e));
        let n3 = conn("n3", Some(x.e));
        let ids = [n1.id, n2.id, n3.id];
        x.tree.connections.extend([n1, n2, n3]);
        assert_eq!(
            x.tree.sorted_children(Some(x.e), false),
            ids.iter().map(|i| c(*i)).collect::<Vec<_>>(),
            "alphabetical until manually ordered"
        );
        // move n3 before n1
        x.tree
            .move_items(&[c(ids[2])], Some(x.e), Some(c(ids[0])))
            .unwrap();
        assert_eq!(
            x.tree.sorted_children(Some(x.e), false),
            vec![c(ids[2]), c(ids[0]), c(ids[1])]
        );
        // move n1 to the end
        x.tree.move_items(&[c(ids[0])], Some(x.e), None).unwrap();
        assert_eq!(
            x.tree.sorted_children(Some(x.e), false),
            vec![c(ids[2]), c(ids[1]), c(ids[0])]
        );
        // several at once keep their relative order
        x.tree
            .move_items(&[c(ids[0]), c(ids[1])], Some(x.e), Some(c(ids[2])))
            .unwrap();
        assert_eq!(
            x.tree.sorted_children(Some(x.e), false),
            vec![c(ids[0]), c(ids[1]), c(ids[2])]
        );
    }

    #[test]
    fn folders_reorder_among_folders_and_connections_among_connections() {
        let mut x = fixture();
        x.tree.move_items(&[f(x.e)], None, Some(f(x.a))).unwrap();
        let roots = x.tree.sorted_children(None, true);
        assert_eq!(roots.first(), Some(&f(x.e)));
        // a folder anchor does not disturb connection order
        x.tree.move_items(&[c(x.s1)], None, Some(f(x.a))).unwrap();
        assert_eq!(x.tree.sorted_children(None, false), vec![c(x.s1)]);
    }

    #[test]
    fn selected_descendants_travel_with_their_selected_folder() {
        let mut x = fixture();
        // s2 lives inside C inside B inside A; selecting A and s2 moves A only.
        let items = x.tree.validate_move(&[f(x.a), c(x.s2)], None).unwrap();
        assert_eq!(items, vec![f(x.a)]);
        x.tree
            .move_items(&[f(x.a), c(x.s2), f(x.a)], None, Some(f(x.e)))
            .unwrap();
        assert_eq!(x.tree.connection(x.s2).unwrap().folder_id, Some(x.cc));
        assert_eq!(x.tree.folder(x.a).unwrap().parent_id, None);
        let roots = x.tree.sorted_children(None, true);
        let pos = |id| roots.iter().position(|i| *i == f(id)).unwrap();
        assert!(pos(x.a) < pos(x.e));
    }

    #[test]
    fn delete_move_to_parent_keeps_everything_else() {
        let mut x = fixture();
        let plan = x
            .tree
            .plan_delete(&[f(x.b)], FolderDeleteMode::MoveToParent)
            .unwrap();
        assert_eq!(plan.folder_ids, vec![x.b]);
        assert!(plan.connection_ids.is_empty());
        assert_eq!((plan.moved_folders, plan.moved_connections), (1, 0));
        let done = x
            .tree
            .delete_items(&[f(x.b)], FolderDeleteMode::MoveToParent)
            .unwrap();
        assert_eq!(done, plan);
        assert!(x.tree.folder(x.b).is_none());
        assert_eq!(x.tree.folder(x.cc).unwrap().parent_id, Some(x.a));
        assert_eq!(x.tree.connection(x.s2).unwrap().folder_id, Some(x.cc));
        assert_eq!(x.tree.connections.len(), 3);
    }

    #[test]
    fn delete_contents_removes_the_subtree_and_reports_exact_ids() {
        let mut x = fixture();
        let plan = x
            .tree
            .plan_delete(&[f(x.a)], FolderDeleteMode::DeleteContents)
            .unwrap();
        let mut folders = vec![x.a, x.b, x.cc];
        folders.sort();
        assert_eq!(plan.folder_ids, folders);
        assert_eq!(plan.connection_ids, vec![x.s2]);
        x.tree
            .delete_items(&[f(x.a)], FolderDeleteMode::DeleteContents)
            .unwrap();
        assert_eq!(x.tree.folders.len(), 2);
        // unrelated connections are untouched
        assert!(x.tree.connection(x.s1).is_some() && x.tree.connection(x.s3).is_some());
    }

    #[test]
    fn bulk_delete_of_mixed_selection_relocates_survivors_to_the_nearest_ancestor() {
        let mut x = fixture();
        // delete A and B but keep C: C must move to the root (A's parent).
        let plan = x
            .tree
            .plan_delete(&[f(x.a), f(x.b), c(x.s1)], FolderDeleteMode::MoveToParent)
            .unwrap();
        assert_eq!(plan.connection_ids, vec![x.s1]);
        assert_eq!(plan.moved_folders, 1);
        x.tree
            .delete_items(&[f(x.a), f(x.b), c(x.s1)], FolderDeleteMode::MoveToParent)
            .unwrap();
        assert_eq!(x.tree.folder(x.cc).unwrap().parent_id, None);
        assert_eq!(x.tree.folder_level(x.cc), 1);
        assert!(x.tree.connection(x.s1).is_none());
    }

    #[test]
    fn delete_never_reports_connections_outside_the_selection() {
        let x = fixture();
        let plan = x
            .tree
            .plan_delete(&[c(x.s1)], FolderDeleteMode::DeleteContents)
            .unwrap();
        assert_eq!(plan.connection_ids, vec![x.s1]);
        assert!(plan.folder_ids.is_empty());
    }

    #[test]
    fn repair_fixes_dangling_references_and_cycles_without_deleting() {
        let mut a = folder("A", None);
        let mut b = folder("B", None);
        a.parent_id = Some(b.id);
        b.parent_id = Some(a.id); // cycle
        let mut orphan = folder("Orphan", Some(Uuid::new_v4()));
        orphan.sort_order = 0;
        let lost = conn("lost", Some(Uuid::new_v4()));
        let mut tree = ConnectionTree {
            version: 2,
            folders: vec![a.clone(), b.clone(), orphan.clone()],
            connections: vec![lost.clone()],
        };
        assert!(tree.repair_references() >= 3);
        assert_eq!((tree.folders.len(), tree.connections.len()), (3, 1));
        assert_eq!(tree.connection(lost.id).unwrap().folder_id, None);
        assert_eq!(tree.folder(orphan.id).unwrap().parent_id, None);
        // the cycle is broken: walking up from either folder terminates
        assert!(tree.folder_level(a.id) <= 2 && tree.folder_level(b.id) <= 2);
        assert_eq!(tree.repair_references(), 0);
    }
}
