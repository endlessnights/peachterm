//! Writing a remote file safely.
//!
//! Content is first written to a temporary file in the **same directory**
//! and only then moved over the target, so a failed or interrupted upload
//! never leaves a half-written target. How atomic the final step is depends on
//! the server, and the outcome says so honestly:
//!
//! * `posix-rename@openssh.com` available: the target is replaced atomically
//!   (`atomic: true`).
//! * Otherwise the old file is renamed aside, the new one moved into place and
//!   the old one removed. A crash between the renames can leave the old content
//!   under the backup name; the target name is never half-written, but the
//!   replacement is **not atomic** (`atomic: false`).
//!
//! The permission bits of an existing target are preserved. Owner and group
//! cannot be set by a normal user and may change when the server creates a new
//! inode; hard links and ACLs are not carried over. Symlinks are resolved first
//! so the link itself is kept and its target is replaced.

use super::{Client, SftpError, ops, parent_remote};
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

const CHUNK: usize = 64 * 1024;
/// Files up to this size are also compared by content hash for conflict checks.
pub const HASH_LIMIT: u64 = 64 * 1024 * 1024;

/// Cheap identity of a remote file version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp {
    pub size: u64,
    pub mtime: Option<u32>,
}

/// What the caller believes the remote file looks like.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expectation {
    pub stamp: Stamp,
    /// SHA-256 of the content that was downloaded, if known.
    pub sha256: Option<[u8; 32]>,
}

#[derive(Debug, Clone, Copy)]
pub struct PutOptions<'a> {
    pub overwrite: bool,
    pub expect: Option<&'a Expectation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PutOutcome {
    pub bytes: u64,
    pub replaced: bool,
    /// The final replacement step was atomic (see the module docs).
    pub atomic: bool,
    pub stamp: Stamp,
}

pub async fn stamp(client: &Client, path: &str) -> Result<Option<Stamp>, SftpError> {
    match client.metadata(path.to_owned()).await {
        Ok(m) => Ok(Some(Stamp {
            size: m.size.unwrap_or(0),
            mtime: m.mtime,
        })),
        Err(russh_sftp::client::error::Error::Status(s))
            if s.status_code == russh_sftp::protocol::StatusCode::NoSuchFile =>
        {
            Ok(None)
        }
        Err(e) => Err(e.into()),
    }
}

/// SHA-256 of a remote file, streamed (nothing is kept in memory).
pub async fn remote_sha256(client: &Client, path: &str) -> Result<[u8; 32], SftpError> {
    let mut file = client.open(path.to_owned()).await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = file.read(&mut buf).await.map_err(|_| SftpError::Failed)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().into())
}

/// Compare the remote file with what the caller expects.
async fn verify(client: &Client, path: &str, expect: &Expectation) -> Result<(), SftpError> {
    let now = stamp(client, path).await?.ok_or(SftpError::RemoteChanged)?;
    if now != expect.stamp {
        return Err(SftpError::RemoteChanged);
    }
    if let Some(wanted) = &expect.sha256
        && now.size <= HASH_LIMIT
        && &remote_sha256(client, path).await? != wanted
    {
        return Err(SftpError::RemoteChanged);
    }
    Ok(())
}

fn temp_name(real: &str) -> String {
    let dir = parent_remote(real);
    let name = real.rsplit('/').next().unwrap_or("file");
    let short: String = name.chars().take(120).collect();
    let tag = uuid::Uuid::new_v4().simple().to_string();
    super::join_remote(&dir, &format!(".{short}.peachterm-{}.part", &tag[..8]))
}

/// Write `reader` (`total` bytes expected) to `remote`. `progress` receives
/// the number of bytes written so far.
pub async fn put_file<R: AsyncRead + Unpin>(
    client: &Client,
    mut reader: R,
    remote: &str,
    options: PutOptions<'_>,
    cancel: &AtomicBool,
    progress: &mut (dyn FnMut(u64) + Send),
) -> Result<PutOutcome, SftpError> {
    ops::validate_path(remote)?;
    if !remote.starts_with('/') || remote.ends_with('/') {
        return Err(SftpError::InvalidPath);
    }
    // Keep symlinks: replace what they point to.
    let real = match client.canonicalize(remote.to_owned()).await {
        Ok(p) if stamp(client, remote).await?.is_some() => p,
        _ => remote.to_owned(),
    };
    let existing = client.metadata(real.clone()).await.ok();
    if let Some(meta) = &existing {
        if meta.is_dir() {
            return Err(SftpError::IsADirectory);
        }
        if !options.overwrite {
            return Err(SftpError::AlreadyExists);
        }
    }
    if let (Some(expect), Some(_)) = (options.expect, &existing) {
        verify(client, &real, expect).await?;
    }

    let temp = temp_name(&real);
    let result = write_and_swap(
        client,
        &mut reader,
        &real,
        &temp,
        existing.as_ref(),
        options,
        cancel,
        progress,
    )
    .await;
    if result.is_err() {
        let _ = client.remove_file(temp).await;
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn write_and_swap<R: AsyncRead + Unpin>(
    client: &Client,
    reader: &mut R,
    real: &str,
    temp: &str,
    existing: Option<&FileAttributes>,
    options: PutOptions<'_>,
    cancel: &AtomicBool,
    progress: &mut (dyn FnMut(u64) + Send),
) -> Result<PutOutcome, SftpError> {
    let mode = existing.and_then(|m| m.permissions).map(|m| m & 0o7777);
    let mut attrs = FileAttributes::empty();
    // Never create the temp file more open than the original: start private.
    attrs.permissions = Some(mode.unwrap_or(0o600));
    let mut file = client
        .open_with_flags_and_attributes(
            temp.to_owned(),
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            attrs,
        )
        .await?;
    let mut buf = vec![0u8; CHUNK];
    let mut written = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(SftpError::Cancelled);
        }
        let n = reader
            .read(&mut buf)
            .await
            .map_err(|_| SftpError::LocalIo)?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .await
            .map_err(|_| SftpError::Failed)?;
        written += n as u64;
        progress(written);
    }
    file.flush().await.map_err(|_| SftpError::Failed)?;
    let _ = file.sync_all().await; // not every server supports fsync
    file.close().await.map_err(|_| SftpError::Failed)?;

    // Keep the original permissions exactly (the umask may have changed them
    // at creation); a new file keeps the private default only until moved.
    if let Some(mode) = mode {
        let mut fix = FileAttributes::empty();
        fix.permissions = Some(mode);
        client.set_metadata(temp.to_owned(), fix).await?;
    } else {
        let mut fix = FileAttributes::empty();
        fix.permissions = Some(0o644);
        let _ = client.set_metadata(temp.to_owned(), fix).await;
    }

    // Last conflict check right before the swap (narrows the race window).
    if let (Some(expect), Some(_)) = (options.expect, existing) {
        verify(client, real, expect).await?;
    }

    let mut atomic = false;
    let mut replaced = false;
    if existing.is_some() {
        replaced = true;
        if client
            .posix_rename(temp.to_owned(), real.to_owned())
            .await?
        {
            atomic = true;
        } else {
            swap_with_backup(client, temp, real).await?;
        }
    } else {
        client.rename(temp.to_owned(), real.to_owned()).await?;
        atomic = true; // creating a new name cannot clobber anything
    }
    let new_stamp = stamp(client, real).await?.unwrap_or(Stamp {
        size: written,
        mtime: None,
    });
    Ok(PutOutcome {
        bytes: written,
        replaced,
        atomic,
        stamp: new_stamp,
    })
}

/// Non-atomic fallback: move the old file aside, move the new one in, drop the
/// old one; restore the old one if the second step fails.
async fn swap_with_backup(client: &Client, temp: &str, real: &str) -> Result<(), SftpError> {
    let backup = format!("{temp}.old");
    client.rename(real.to_owned(), backup.clone()).await?;
    if let Err(e) = client.rename(temp.to_owned(), real.to_owned()).await {
        let _ = client.rename(backup, real.to_owned()).await;
        return Err(e.into());
    }
    let _ = client.remove_file(backup).await;
    Ok(())
}
