// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Uploading local folders: a bounded, symlink-free walk of the local tree and
//! a conflict check against the remote side. Paths are validated component by
//! component, so nothing in a dropped tree can name a remote path outside the
//! destination root.
//!
//! The walk never follows symbolic links (and never enters a directory it has
//! already visited), so a link loop cannot make it run forever; special files
//! (devices, sockets, FIFOs) are skipped and counted.

use super::{Client, SftpError, join_remote, ops};
use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};

/// More entries than this in one drop is refused: a drop is a deliberate,
/// human-sized action, not a backup job.
pub const MAX_ENTRIES: usize = 20_000;
pub const MAX_DEPTH: usize = 24;
/// At most this many things can be dropped at once.
pub const MAX_TOP_LEVEL: usize = 500;
/// Remote directories listed for the conflict check.
const MAX_CONFLICT_DIRS: usize = 400;
const MAX_CONFLICT_SAMPLES: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    /// A directory below the destination root (`rel` = its path components).
    Dir { rel: Vec<String> },
    File {
        abs: PathBuf,
        rel: Vec<String>,
        size: u64,
    },
}

impl Node {
    pub fn rel(&self) -> &[String] {
        match self {
            Node::Dir { rel } | Node::File { rel, .. } => rel,
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Skipped {
    pub symlinks: usize,
    pub special: usize,
    pub unreadable: usize,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct LocalPlan {
    /// Parents before children, so directories can be created in order.
    pub nodes: Vec<Node>,
    pub files: usize,
    pub dirs: usize,
    pub bytes: u64,
    pub skipped: Skipped,
}

/// One path component the local file system gave us: must be usable as a
/// single remote name. Anything else aborts the whole plan.
fn component(name: std::ffi::OsString) -> Result<Option<String>, SftpError> {
    let Ok(name) = name.into_string() else {
        // Not representable as text: it cannot be sent faithfully.
        return Ok(None);
    };
    ops::validate_name(&name)?;
    Ok(Some(name))
}

/// Plans the upload of the dropped/picked `paths` (files and folders).
pub fn plan_local(paths: &[PathBuf]) -> Result<LocalPlan, SftpError> {
    if paths.is_empty() || paths.len() > MAX_TOP_LEVEL {
        return Err(if paths.is_empty() {
            SftpError::InvalidPath
        } else {
            SftpError::TooMany
        });
    }
    let mut plan = LocalPlan::default();
    let mut top_names: HashSet<String> = HashSet::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    for path in paths {
        let name = path
            .file_name()
            .ok_or(SftpError::InvalidPath)
            .and_then(|n| component(n.to_owned())?.ok_or(SftpError::InvalidPath))?;
        // Two dropped items with the same name would silently merge or overwrite.
        if !top_names.insert(name.clone()) {
            return Err(SftpError::AlreadyExists);
        }
        let meta = std::fs::symlink_metadata(path).map_err(|_| SftpError::LocalIo)?;
        let kind = meta.file_type();
        if kind.is_symlink() {
            plan.skipped.symlinks += 1;
        } else if kind.is_file() {
            push(
                &mut plan,
                Node::File {
                    abs: path.clone(),
                    rel: vec![name],
                    size: meta.len(),
                },
            )?;
        } else if kind.is_dir() {
            walk(path, vec![name], &mut plan, &mut seen)?;
        } else {
            plan.skipped.special += 1;
        }
    }
    Ok(plan)
}

fn push(plan: &mut LocalPlan, node: Node) -> Result<(), SftpError> {
    if plan.nodes.len() >= MAX_ENTRIES {
        return Err(SftpError::TooMany);
    }
    match &node {
        Node::Dir { .. } => plan.dirs += 1,
        Node::File { size, .. } => {
            plan.files += 1;
            plan.bytes = plan.bytes.saturating_add(*size);
        }
    }
    plan.nodes.push(node);
    Ok(())
}

fn walk(
    root: &Path,
    root_rel: Vec<String>,
    plan: &mut LocalPlan,
    seen: &mut HashSet<PathBuf>,
) -> Result<(), SftpError> {
    // Iterative depth-first walk: the stack holds directories still to read.
    let mut stack = vec![(root.to_path_buf(), root_rel)];
    while let Some((dir, rel)) = stack.pop() {
        if rel.len() > MAX_DEPTH {
            return Err(SftpError::TooMany);
        }
        // A directory reached twice (junction, bind mount, loop) is entered once.
        let canonical = std::fs::canonicalize(&dir).map_err(|_| SftpError::LocalIo)?;
        if !seen.insert(canonical) {
            plan.skipped.symlinks += 1;
            continue;
        }
        push(plan, Node::Dir { rel: rel.clone() })?;
        let Ok(read) = std::fs::read_dir(&dir) else {
            plan.skipped.unreadable += 1;
            continue;
        };
        let mut entries: Vec<_> = read.filter_map(Result::ok).collect();
        entries.sort_by_key(|e| e.file_name());
        let mut subdirs = Vec::new();
        for entry in entries {
            let Some(name) = component(entry.file_name())? else {
                plan.skipped.unreadable += 1;
                continue;
            };
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                plan.skipped.unreadable += 1;
                continue;
            };
            let kind = meta.file_type();
            let mut child = rel.clone();
            child.push(name);
            if kind.is_symlink() {
                plan.skipped.symlinks += 1;
            } else if kind.is_file() {
                push(
                    plan,
                    Node::File {
                        abs: entry.path(),
                        rel: child,
                        size: meta.len(),
                    },
                )?;
            } else if kind.is_dir() {
                subdirs.push((entry.path(), child));
            } else {
                plan.skipped.special += 1;
            }
        }
        // Sub-directories are pushed reversed so they come out in name order.
        for item in subdirs.into_iter().rev() {
            stack.push(item);
        }
    }
    Ok(())
}

/// The remote path of a node below `remote_root`.
pub fn remote_path(remote_root: &str, rel: &[String]) -> String {
    rel.iter()
        .fold(remote_root.to_owned(), |acc, c| join_remote(&acc, c))
}

#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflicts {
    pub count: usize,
    /// A few relative paths to show in the confirmation.
    pub samples: Vec<String>,
}

/// Which files of `plan` already exist below `remote_root`. Reads each remote
/// directory once; directories that do not exist yet hold no conflicts. A file
/// where a folder is needed (or the reverse) is an error, never overwritten.
pub async fn find_conflicts(
    client: &Client,
    remote_root: &str,
    plan: &LocalPlan,
) -> Result<Conflicts, SftpError> {
    ops::validate_path(remote_root)?;
    let root = client.metadata(remote_root.to_owned()).await?;
    if !root.is_dir() {
        return Err(SftpError::NotADirectory);
    }
    let mut dirs: BTreeSet<Vec<String>> = BTreeSet::new();
    dirs.insert(Vec::new());
    for node in &plan.nodes {
        let rel = node.rel();
        match node {
            Node::Dir { .. } => {
                dirs.insert(rel.to_vec());
            }
            Node::File { .. } => {
                dirs.insert(rel[..rel.len() - 1].to_vec());
            }
        }
    }
    if dirs.len() > MAX_CONFLICT_DIRS {
        // Too many folders to inspect one by one: ask for the safe policy.
        return Err(SftpError::TooMany);
    }
    let mut existing: std::collections::HashMap<
        Vec<String>,
        Option<std::collections::HashMap<String, bool>>,
    > = Default::default();
    for dir in &dirs {
        let path = remote_path(remote_root, dir);
        let listing = match client.metadata(path.clone()).await {
            Ok(meta) if meta.is_dir() => {
                let mut names = std::collections::HashMap::new();
                for item in client.read_dir(path).await? {
                    let name = item.file_name();
                    if name != "." && name != ".." {
                        names.insert(name, item.metadata().is_dir());
                    }
                }
                Some(names)
            }
            Ok(_) => return Err(SftpError::AlreadyExists), // a file is in the way of a folder
            Err(_) => None,
        };
        existing.insert(dir.clone(), listing);
    }
    let mut conflicts = Conflicts::default();
    for node in &plan.nodes {
        let rel = node.rel();
        let (parent, name) = rel.split_at(rel.len() - 1);
        let Some(Some(names)) = existing.get(parent) else {
            continue;
        };
        match (node, names.get(&name[0])) {
            (Node::File { .. }, Some(false)) => {
                conflicts.count += 1;
                if conflicts.samples.len() < MAX_CONFLICT_SAMPLES {
                    conflicts.samples.push(rel.join("/"));
                }
            }
            // a folder where a file is expected (or a file where a folder is)
            (Node::File { .. }, Some(true)) | (Node::Dir { .. }, Some(false)) => {
                return Err(SftpError::AlreadyExists);
            }
            _ => {}
        }
    }
    Ok(conflicts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn rels(plan: &LocalPlan) -> Vec<String> {
        plan.nodes
            .iter()
            .map(|n| {
                let tag = if matches!(n, Node::Dir { .. }) {
                    "d"
                } else {
                    "f"
                };
                format!("{tag}:{}", n.rel().join("/"))
            })
            .collect()
    }

    #[test]
    fn a_single_file_keeps_its_name() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.yml");
        fs::write(&file, b"a: 1").unwrap();
        let plan = plan_local(&[file]).unwrap();
        assert_eq!(rels(&plan), ["f:config.yml"]);
        assert_eq!((plan.files, plan.dirs, plan.bytes), (1, 0, 4));
    }

    #[test]
    fn a_folder_is_planned_with_its_name_and_relative_hierarchy() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("myservice");
        fs::create_dir_all(root.join("config")).unwrap();
        fs::write(root.join("compose.yaml"), b"x").unwrap();
        fs::write(root.join(".env.example"), b"y").unwrap();
        fs::write(root.join("config").join("app.yml"), b"zz").unwrap();
        let plan = plan_local(&[root]).unwrap();
        assert_eq!(
            rels(&plan),
            [
                "d:myservice",
                "f:myservice/.env.example",
                "f:myservice/compose.yaml",
                "d:myservice/config",
                "f:myservice/config/app.yml"
            ]
        );
        assert_eq!((plan.files, plan.dirs, plan.bytes), (3, 2, 4));
        // directories always come before what is inside them
        let first_file = plan
            .nodes
            .iter()
            .position(|n| matches!(n, Node::File { .. }))
            .unwrap();
        assert!(matches!(plan.nodes[0], Node::Dir { .. }) && first_file > 0);
    }

    #[test]
    fn unicode_names_survive() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Проект ü 日本");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("файл — 1.txt"), b"1").unwrap();
        let plan = plan_local(&[root]).unwrap();
        assert_eq!(
            rels(&plan),
            ["d:Проект ü 日本", "f:Проект ü 日本/файл — 1.txt"]
        );
    }

    #[test]
    fn several_top_level_items_and_name_clashes() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.txt");
        fs::write(&a, b"1").unwrap();
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        let b = sub.join("a.txt");
        fs::write(&b, b"2").unwrap();
        assert_eq!(plan_local(&[a.clone(), sub]).unwrap().files, 2);
        // two items called a.txt would merge: refused, not silently renamed
        assert_eq!(plan_local(&[a, b]), Err(SftpError::AlreadyExists));
    }

    #[test]
    fn missing_sources_and_empty_drops_are_errors() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            plan_local(&[dir.path().join("gone")]),
            Err(SftpError::LocalIo)
        );
        assert_eq!(plan_local(&[]), Err(SftpError::InvalidPath));
    }

    #[test]
    fn path_components_that_could_escape_the_destination_are_rejected() {
        // Names can never contain a separator or be "." / ".." / control characters.
        for bad in ["..", ".", "", "a/b", "a\nb", "a\u{0}b", "x\u{7f}y"] {
            assert!(ops::validate_name(bad).is_err(), "{bad:?}");
        }
        assert!(component("..".into()).is_err());
        assert!(component("ok name".into()).unwrap().is_some());
        // joining stays inside the root
        assert_eq!(
            remote_path("/opt/app", &["svc".into(), "a b".into()]),
            "/opt/app/svc/a b"
        );
        assert_eq!(remote_path("/", &["x".into()]), "/x");
    }

    #[test]
    fn too_many_entries_and_too_deep_trees_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let deep = (0..MAX_DEPTH + 2).fold(dir.path().join("d"), |p, i| p.join(format!("n{i}")));
        fs::create_dir_all(&deep).unwrap();
        assert_eq!(plan_local(&[dir.path().join("d")]), Err(SftpError::TooMany));
        let many = tempfile::tempdir().unwrap();
        let paths: Vec<_> = (0..MAX_TOP_LEVEL + 1)
            .map(|i| {
                let p = many.path().join(format!("f{i}"));
                fs::write(&p, b"").unwrap();
                p
            })
            .collect();
        assert_eq!(plan_local(&paths), Err(SftpError::TooMany));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_skipped_not_followed_and_loops_cannot_hang() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir_all(root.join("real")).unwrap();
        fs::write(root.join("real").join("f.txt"), b"1").unwrap();
        symlink(&root, root.join("real").join("loop")).unwrap(); // directory loop
        symlink(root.join("real").join("f.txt"), root.join("link.txt")).unwrap();
        symlink("/etc", root.join("etc-link")).unwrap();
        let outside = dir.path().join("outside.txt");
        symlink(root.join("real").join("f.txt"), &outside).unwrap();
        let plan = plan_local(&[root, outside]).unwrap();
        assert_eq!(rels(&plan), ["d:proj", "d:proj/real", "f:proj/real/f.txt"]);
        assert_eq!(plan.skipped.symlinks, 4);
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_become_posix_components() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("svc");
        fs::create_dir_all(root.join("conf")).unwrap();
        fs::write(root.join("conf").join("a.yml"), b"1").unwrap();
        let plan = plan_local(&[root]).unwrap();
        // no backslashes ever reach the remote path
        assert!(
            plan.nodes
                .iter()
                .all(|n| n.rel().iter().all(|c| !c.contains('\\')))
        );
        assert_eq!(
            remote_path("/opt", plan.nodes.last().unwrap().rel()),
            "/opt/svc/conf/a.yml"
        );
    }
}
