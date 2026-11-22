//! Browsing and file operations over an SFTP client.
//!
//! Paths coming from the renderer are validated here (no NUL / control
//! characters, bounded length); names for new or renamed items must be a
//! single path component. Deletion never follows symlinks.

use super::{Client, SftpError, join_remote, parent_remote};
use russh_sftp::protocol::FileType;
use serde::Serialize;

const MAX_PATH: usize = 4096;
const MAX_NAME: usize = 255;
/// Recursive deletes stop here instead of running away on a hostile tree.
const MAX_DELETE_ENTRIES: u64 = 100_000;
const MAX_DELETE_DEPTH: usize = 64;
/// Symlinks resolved per listing (each costs a round trip).
const MAX_LINK_LOOKUPS: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    /// For a symlink: does it point to a directory?
    pub target_is_dir: bool,
    pub size: u64,
    /// Seconds since the Unix epoch, if the server reported it.
    pub modified: Option<u64>,
    /// POSIX permission bits (without the file type), if reported.
    pub mode: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// Canonical absolute path that was listed.
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<RemoteEntry>,
}

pub fn validate_path(path: &str) -> Result<(), SftpError> {
    if path.is_empty() || path.len() > MAX_PATH || path.chars().any(char::is_control) {
        return Err(SftpError::InvalidPath);
    }
    Ok(())
}

/// A single path component for a new or renamed item.
pub fn validate_name(name: &str) -> Result<(), SftpError> {
    let bad = name.is_empty()
        || name.len() > MAX_NAME
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.chars().any(char::is_control);
    if bad {
        return Err(SftpError::InvalidPath);
    }
    Ok(())
}

pub async fn canonical(client: &Client, path: &str) -> Result<String, SftpError> {
    validate_path(path)?;
    Ok(client.canonicalize(path).await?)
}

/// List a directory (`None` = the login directory). Entries are unsorted;
/// the UI sorts and filters hidden files.
pub async fn list(client: &Client, path: Option<&str>) -> Result<Listing, SftpError> {
    let requested = path.unwrap_or(".");
    let dir = canonical(client, requested).await?;
    let meta = client.metadata(dir.clone()).await?;
    if !meta.is_dir() {
        return Err(SftpError::NotADirectory);
    }
    let mut entries = Vec::new();
    let mut lookups = 0;
    for item in client.read_dir(dir.clone()).await? {
        let name = item.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let attrs = item.metadata();
        let kind = match item.file_type() {
            FileType::Dir => EntryKind::Directory,
            FileType::File => EntryKind::File,
            FileType::Symlink => EntryKind::Symlink,
            FileType::Other => EntryKind::Other,
        };
        let full = join_remote(&dir, &name);
        let mut target_is_dir = false;
        if kind == EntryKind::Symlink && lookups < MAX_LINK_LOOKUPS {
            lookups += 1;
            target_is_dir = client
                .metadata(full.clone())
                .await
                .map(|m| m.is_dir())
                .unwrap_or(false);
        }
        entries.push(RemoteEntry {
            name,
            path: full,
            kind,
            target_is_dir,
            size: attrs.size.unwrap_or(0),
            modified: attrs.mtime.map(u64::from),
            mode: attrs.permissions.map(|m| m & 0o7777),
        });
    }
    let parent = (dir != "/").then(|| parent_remote(&dir));
    Ok(Listing {
        path: dir,
        parent,
        entries,
    })
}

async fn exists(client: &Client, path: &str) -> bool {
    client.symlink_metadata(path.to_owned()).await.is_ok()
}

pub async fn mkdir(client: &Client, parent: &str, name: &str) -> Result<String, SftpError> {
    validate_path(parent)?;
    validate_name(name)?;
    let path = join_remote(parent, name);
    if exists(client, &path).await {
        return Err(SftpError::AlreadyExists);
    }
    client.create_dir(path.clone()).await?;
    Ok(path)
}

/// Rename inside the same directory. Never replaces an existing item.
pub async fn rename(client: &Client, path: &str, new_name: &str) -> Result<String, SftpError> {
    validate_path(path)?;
    validate_name(new_name)?;
    if path == "/" {
        return Err(SftpError::InvalidPath);
    }
    let target = join_remote(&parent_remote(path), new_name);
    if target == path {
        return Ok(target);
    }
    if exists(client, &target).await {
        return Err(SftpError::AlreadyExists);
    }
    client.rename(path.to_owned(), target.clone()).await?;
    Ok(target)
}

/// Delete a file, a symlink (the link, not its target) or a directory tree.
/// Returns how many items were removed.
pub async fn delete(client: &Client, path: &str) -> Result<u64, SftpError> {
    validate_path(path)?;
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." || !path.starts_with('/') {
        return Err(SftpError::InvalidPath);
    }
    let mut removed = 0;
    delete_tree(client, trimmed, 0, &mut removed).await?;
    Ok(removed)
}

fn delete_tree<'a>(
    client: &'a Client,
    path: &'a str,
    depth: usize,
    removed: &'a mut u64,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), SftpError>> + Send + 'a>> {
    Box::pin(async move {
        if depth > MAX_DELETE_DEPTH || *removed > MAX_DELETE_ENTRIES {
            return Err(SftpError::Failed);
        }
        let meta = client.symlink_metadata(path.to_owned()).await?;
        if meta.is_dir() {
            for item in client.read_dir(path.to_owned()).await? {
                let name = item.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                delete_tree(client, &join_remote(path, &name), depth + 1, removed).await?;
            }
            client.remove_dir(path.to_owned()).await?;
        } else {
            client.remove_file(path.to_owned()).await?;
        }
        *removed += 1;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_must_be_single_components() {
        for bad in ["", ".", "..", "a/b", "a\nb", "a\0b", &"x".repeat(300)] {
            assert_eq!(validate_name(bad), Err(SftpError::InvalidPath), "{bad:?}");
        }
        assert!(validate_name("report 2024.txt").is_ok());
        assert!(validate_name(".bashrc").is_ok());
    }

    #[test]
    fn paths_are_bounded_and_free_of_control_characters() {
        assert_eq!(validate_path(""), Err(SftpError::InvalidPath));
        assert_eq!(validate_path("/a\nb"), Err(SftpError::InvalidPath));
        assert_eq!(
            validate_path(&"/x".repeat(3000)),
            Err(SftpError::InvalidPath)
        );
        assert!(validate_path("/var/log").is_ok());
    }
}
