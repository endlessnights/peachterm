// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! User-visible uploads and downloads with progress and cancellation.
//!
//! Local paths never come from the renderer: a native dialog opened by Rust
//! picks them, and the renderer only holds an opaque id (`Picks`) for the
//! files that were chosen for upload.

use super::put::{PutOptions, put_file};
use super::tree::{self, Node};
use super::{Client, SftpError, join_remote, ops};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

const CHUNK: usize = 64 * 1024;
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
const PICK_TTL: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Upload,
    Download,
}

impl Direction {
    fn token(self) -> &'static str {
        match self {
            Self::Upload => "upload",
            Self::Download => "download",
        }
    }
}

/// Progress stream for the renderer. Contains file *names* (shown in the
/// panel) but never paths or content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TransferEvent {
    Started {
        transfer_id: Uuid,
        name: String,
        direction: Direction,
        total: u64,
        index: u32,
        count: u32,
    },
    Progress {
        transfer_id: Uuid,
        done: u64,
        total: u64,
    },
    Completed {
        transfer_id: Uuid,
        bytes: u64,
    },
    Failed {
        transfer_id: Uuid,
        reason: String,
        message: String,
    },
    Cancelled {
        transfer_id: Uuid,
    },
    /// The whole batch is over (also after failures and cancellation).
    Finished,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub name: String,
    pub size: u64,
}

#[derive(Default)]
pub struct Hub {
    cancels: Mutex<HashMap<Uuid, Arc<AtomicBool>>>,
    picks: Mutex<HashMap<Uuid, (Instant, Vec<PathBuf>)>>,
}

impl Hub {
    pub fn cancel(&self, id: Uuid) -> bool {
        match self.cancels.lock().unwrap().get(&id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    fn register(&self, id: Uuid) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.cancels.lock().unwrap().insert(id, flag.clone());
        flag
    }

    fn unregister(&self, id: Uuid) {
        self.cancels.lock().unwrap().remove(&id);
    }

    /// Remember files chosen in the native dialog; returns the opaque id and
    /// what the UI may show about them.
    pub fn remember_pick(&self, paths: Vec<PathBuf>) -> (Uuid, Vec<PickedFile>) {
        let files = paths
            .iter()
            .map(|p| PickedFile {
                name: p
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                size: std::fs::metadata(p).map(|m| m.len()).unwrap_or(0),
            })
            .collect();
        let id = Uuid::new_v4();
        let mut picks = self.picks.lock().unwrap();
        picks.retain(|_, (at, _)| at.elapsed() < PICK_TTL);
        picks.insert(id, (Instant::now(), paths));
        (id, files)
    }

    /// Remember paths that came from an operating-system drop (never from the
    /// renderer). Files and folders; the renderer only gets the opaque id.
    pub fn remember_drop(&self, paths: Vec<PathBuf>) -> Uuid {
        let id = Uuid::new_v4();
        let mut picks = self.picks.lock().unwrap();
        picks.retain(|_, (at, _)| at.elapsed() < PICK_TTL);
        picks.insert(id, (Instant::now(), paths));
        id
    }

    /// Look at a pick without using it up (the conflict check before an upload).
    pub fn peek_pick(&self, id: Uuid) -> Option<Vec<PathBuf>> {
        let picks = self.picks.lock().unwrap();
        let (at, paths) = picks.get(&id)?;
        (at.elapsed() < PICK_TTL).then(|| paths.clone())
    }

    /// Forget every pending selection (the application locked).
    pub fn clear_picks(&self) {
        self.picks.lock().unwrap().clear();
    }

    pub fn discard_pick(&self, id: Uuid) {
        self.picks.lock().unwrap().remove(&id);
    }

    /// Single use: a pick can be uploaded once.
    pub fn take_pick(&self, id: Uuid) -> Option<Vec<PathBuf>> {
        let (at, paths) = self.picks.lock().unwrap().remove(&id)?;
        (at.elapsed() < PICK_TTL).then_some(paths)
    }
}

fn failed(id: Uuid, error: SftpError) -> TransferEvent {
    TransferEvent::Failed {
        transfer_id: id,
        reason: error.token().to_owned(),
        message: error.message().to_owned(),
    }
}

/// Rate-limits progress events.
struct Throttle {
    last: Instant,
}

impl Throttle {
    fn new() -> Self {
        Self {
            last: Instant::now() - PROGRESS_EVERY,
        }
    }
    fn due(&mut self, done: u64, total: u64) -> bool {
        if done >= total || self.last.elapsed() >= PROGRESS_EVERY {
            self.last = Instant::now();
            true
        } else {
            false
        }
    }
}

/// Download one remote file to `dest`. The data goes to a `.part` file next to
/// the destination first, so a cancelled or failed download leaves nothing at
/// the destination name.
pub async fn run_download(
    client: &Client,
    hub: &Hub,
    session_id: Uuid,
    remote: &str,
    dest: &Path,
    emit: &(dyn Fn(TransferEvent) + Send + Sync),
) -> Result<u64, SftpError> {
    let id = Uuid::new_v4();
    let cancel = hub.register(id);
    let name = remote.rsplit('/').next().unwrap_or("file").to_owned();
    let started = Instant::now();
    let result = download_inner(client, id, &name, remote, dest, &cancel, session_id, emit).await;
    hub.unregister(id);
    finish(id, session_id, Direction::Download, started, &result, emit);
    emit(TransferEvent::Finished);
    result
}

#[allow(clippy::too_many_arguments)]
async fn download_inner(
    client: &Client,
    id: Uuid,
    name: &str,
    remote: &str,
    dest: &Path,
    cancel: &AtomicBool,
    session_id: Uuid,
    emit: &(dyn Fn(TransferEvent) + Send + Sync),
) -> Result<u64, SftpError> {
    ops::validate_path(remote)?;
    let meta = client.metadata(remote.to_owned()).await?;
    if meta.is_dir() {
        return Err(SftpError::IsADirectory);
    }
    let total = meta.size.unwrap_or(0);
    tracing::info!(event = "sftp.transfer_started", session_id = %session_id, transfer_id = %id, kind = "download", bytes = total);
    emit(TransferEvent::Started {
        transfer_id: id,
        name: name.to_owned(),
        direction: Direction::Download,
        total,
        index: 1,
        count: 1,
    });
    let mut source = client.open(remote.to_owned()).await?;
    let part = part_path(dest);
    let outcome = async {
        let mut out = tokio::fs::File::create(&part).await?;
        let mut buf = vec![0u8; CHUNK];
        let mut done = 0u64;
        let mut throttle = Throttle::new();
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(SftpError::Cancelled);
            }
            let n = source.read(&mut buf).await.map_err(|_| SftpError::Failed)?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).await?;
            done += n as u64;
            if throttle.due(done, total) {
                emit(TransferEvent::Progress {
                    transfer_id: id,
                    done,
                    total,
                });
            }
        }
        out.flush().await?;
        out.sync_all().await?;
        drop(out);
        tokio::fs::rename(&part, dest).await?;
        Ok(done)
    }
    .await;
    if outcome.is_err() {
        let _ = tokio::fs::remove_file(&part).await;
    }
    outcome
}

fn part_path(dest: &Path) -> PathBuf {
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    dest.with_file_name(format!(".{name}.peachterm-part"))
}

/// Upload files one after another into `remote_dir`.
pub async fn run_upload(
    client: &Client,
    hub: &Hub,
    session_id: Uuid,
    files: &[PathBuf],
    remote_dir: &str,
    overwrite: bool,
    emit: &(dyn Fn(TransferEvent) + Send + Sync),
) {
    let count = u32::try_from(files.len()).unwrap_or(u32::MAX);
    let mut stop = false;
    for (index, path) in files.iter().enumerate() {
        if stop {
            break;
        }
        let id = Uuid::new_v4();
        let cancel = hub.register(id);
        let started = Instant::now();
        let result = upload_one(
            client,
            id,
            path,
            remote_dir,
            overwrite,
            &cancel,
            session_id,
            u32::try_from(index + 1).unwrap_or(u32::MAX),
            count,
            emit,
        )
        .await;
        hub.unregister(id);
        stop = matches!(result, Err(SftpError::Cancelled));
        finish(id, session_id, Direction::Upload, started, &result, emit);
    }
    emit(TransferEvent::Finished);
}

#[allow(clippy::too_many_arguments)]
async fn upload_one(
    client: &Client,
    id: Uuid,
    path: &Path,
    remote_dir: &str,
    overwrite: bool,
    cancel: &AtomicBool,
    session_id: Uuid,
    index: u32,
    count: u32,
    emit: &(dyn Fn(TransferEvent) + Send + Sync),
) -> Result<u64, SftpError> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or(SftpError::InvalidPath)?;
    ops::validate_name(&name)?;
    ops::validate_path(remote_dir)?;
    let meta = tokio::fs::metadata(path).await?;
    if !meta.is_file() {
        return Err(SftpError::LocalIo);
    }
    let total = meta.len();
    tracing::info!(event = "sftp.transfer_started", session_id = %session_id, transfer_id = %id, kind = "upload", bytes = total);
    emit(TransferEvent::Started {
        transfer_id: id,
        name: name.clone(),
        direction: Direction::Upload,
        total,
        index,
        count,
    });
    let reader = tokio::fs::File::open(path).await?;
    let mut throttle = Throttle::new();
    let mut report = |done: u64| {
        if throttle.due(done, total) {
            emit(TransferEvent::Progress {
                transfer_id: id,
                done,
                total,
            });
        }
    };
    let outcome = put_file(
        client,
        reader,
        &join_remote(remote_dir, &name),
        PutOptions {
            overwrite,
            expect: None,
        },
        cancel,
        &mut report,
    )
    .await?;
    Ok(outcome.bytes)
}

fn finish(
    id: Uuid,
    session_id: Uuid,
    direction: Direction,
    started: Instant,
    result: &Result<u64, SftpError>,
    emit: &(dyn Fn(TransferEvent) + Send + Sync),
) {
    let ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    match result {
        Ok(bytes) => {
            tracing::info!(event = "sftp.transfer_completed", session_id = %session_id, transfer_id = %id, kind = direction.token(), bytes = *bytes, duration_ms = ms);
            emit(TransferEvent::Completed {
                transfer_id: id,
                bytes: *bytes,
            });
        }
        Err(SftpError::Cancelled) => {
            tracing::info!(event = "sftp.transfer_failed", session_id = %session_id, transfer_id = %id, kind = direction.token(), reason = "cancelled");
            emit(TransferEvent::Cancelled { transfer_id: id });
        }
        Err(error) => {
            tracing::warn!(event = "sftp.transfer_failed", session_id = %session_id, transfer_id = %id, kind = direction.token(), reason = error.token());
            emit(failed(id, *error));
        }
    }
}

/// Upload a picked/dropped set that contains folders: the same per-file engine
/// as [`run_upload`] (`put_file`: safe replace, progress, cancellation, the
/// overwrite policy), plus creation of the remote folders. Folders that exist
/// are reused; files are never overwritten unless `overwrite` was confirmed.
/// A failure of one file or folder is reported and the rest continues; a
/// cancellation stops the batch.
pub async fn run_upload_tree(
    client: &Client,
    hub: &Hub,
    session_id: Uuid,
    paths: &[PathBuf],
    remote_dir: &str,
    overwrite: bool,
    emit: &(dyn Fn(TransferEvent) + Send + Sync),
) {
    let plan = match tree::plan_local(paths) {
        Ok(plan) => plan,
        Err(error) => {
            // Nothing was started: one failed entry explains why.
            let id = Uuid::new_v4();
            emit(TransferEvent::Started {
                transfer_id: id,
                name: String::new(),
                direction: Direction::Upload,
                total: 0,
                index: 1,
                count: 1,
            });
            emit(failed(id, error));
            emit(TransferEvent::Finished);
            return;
        }
    };
    let count = u32::try_from(plan.files).unwrap_or(u32::MAX);
    let mut index = 0u32;
    let mut broken: Vec<Vec<String>> = Vec::new(); // folders that could not be created
    for node in &plan.nodes {
        if broken.iter().any(|b| node.rel().starts_with(b)) {
            continue; // its folder is missing: already reported once
        }
        let remote = tree::remote_path(remote_dir, node.rel());
        let name = node.rel().join("/");
        let id = Uuid::new_v4();
        match node {
            Node::Dir { rel } => {
                if let Err(error) = ensure_dir(client, &remote).await {
                    emit(TransferEvent::Started {
                        transfer_id: id,
                        name: format!("{name}/"),
                        direction: Direction::Upload,
                        total: 0,
                        index: index.max(1),
                        count: count.max(1),
                    });
                    emit(failed(id, error));
                    broken.push(rel.clone());
                }
            }
            Node::File { abs, size, .. } => {
                index += 1;
                let cancel = hub.register(id);
                let started = Instant::now();
                let result = upload_node(
                    client, id, abs, &remote, &name, *size, overwrite, &cancel, session_id, index,
                    count, emit,
                )
                .await;
                hub.unregister(id);
                let stop = matches!(result, Err(SftpError::Cancelled));
                finish(id, session_id, Direction::Upload, started, &result, emit);
                if stop {
                    break;
                }
            }
        }
    }
    emit(TransferEvent::Finished);
}

/// A remote folder that exists is reused; a missing one is created; anything
/// else of that name (a file, a link) is an error, never replaced.
async fn ensure_dir(client: &Client, path: &str) -> Result<(), SftpError> {
    ops::validate_path(path)?;
    match client.symlink_metadata(path.to_owned()).await {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => Err(SftpError::AlreadyExists),
        Err(_) => {
            client.create_dir(path.to_owned()).await?;
            Ok(())
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn upload_node(
    client: &Client,
    id: Uuid,
    abs: &Path,
    remote: &str,
    name: &str,
    planned_size: u64,
    overwrite: bool,
    cancel: &AtomicBool,
    session_id: Uuid,
    index: u32,
    count: u32,
    emit: &(dyn Fn(TransferEvent) + Send + Sync),
) -> Result<u64, SftpError> {
    ops::validate_path(remote)?;
    // The tree may have changed since it was planned: never follow a link that
    // appeared meanwhile, and only send regular files.
    let meta = tokio::fs::symlink_metadata(abs).await?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(SftpError::LocalIo);
    }
    let total = meta.len().max(planned_size.min(meta.len()));
    tracing::info!(event = "sftp.transfer_started", session_id = %session_id, transfer_id = %id, kind = "upload", bytes = total);
    emit(TransferEvent::Started {
        transfer_id: id,
        name: name.to_owned(),
        direction: Direction::Upload,
        total,
        index,
        count,
    });
    let reader = tokio::fs::File::open(abs).await?;
    let mut throttle = Throttle::new();
    let mut report = |done: u64| {
        if throttle.due(done, total) {
            emit(TransferEvent::Progress {
                transfer_id: id,
                done,
                total,
            });
        }
    };
    let outcome = put_file(
        client,
        reader,
        remote,
        PutOptions {
            overwrite,
            expect: None,
        },
        cancel,
        &mut report,
    )
    .await?;
    Ok(outcome.bytes)
}
