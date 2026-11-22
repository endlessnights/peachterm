//! The external-editor round trip.
//!
//! open remote file → managed private copy → editor → watch the copy →
//! (confirm) → conflict-checked safe upload.
//!
//! SECURITY: nothing here can write to a server without an
//! [`UploadAuthorization`], which only `sessions::SessionRegistry` can mint
//! (after an explicit answer, or while the in-memory "Yes to all" of *this*
//! SSH session is active). [`Edit::upload`] takes the authorization **by value**
//! and re-checks that it covers the session, the remote path and the exact
//! content hash it is about to send. The policy itself lives in Rust only.

use super::policy::{Decision, UploadAuthorization, UserAnswer, WriteRequest};
use super::tempfiles::{self, EditFiles};
use crate::lock::LockFlag;
use crate::sessions::{SessionId, SessionRegistry};
use crate::sftp::put::{Expectation, PutOptions, Stamp, put_file, stamp};
use crate::sftp::{Client, SftpError, ops};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tokio::io::AsyncReadExt;
use tokio::sync::Notify;
use uuid::Uuid;

/// Largest remote file opened for editing.
pub const MAX_EDIT_BYTES: u64 = 64 * 1024 * 1024;

pub type Hash = [u8; 32];

pub fn sha256(data: &[u8]) -> Hash {
    Sha256::digest(data).into()
}

#[derive(Debug, Clone, Copy)]
pub struct Timing {
    /// How often the local file is looked at.
    pub poll: Duration,
    /// A change must stay unchanged this long before it is read (debounce;
    /// editors often write in several steps or via temp file + rename).
    pub settle: Duration,
    /// Largest remote file that may be opened for editing.
    pub max_bytes: u64,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            poll: Duration::from_millis(300),
            settle: Duration::from_millis(700),
            max_bytes: MAX_EDIT_BYTES,
        }
    }
}

/// What the renderer is told. Names are shown to the user; no content, no
/// local paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EditorEvent {
    Opened {
        edit_id: Uuid,
        session_id: Uuid,
        name: String,
        remote_path: String,
    },
    /// "Remote file modified": ask Yes / Yes to all / No / Cancel.
    Confirm {
        edit_id: Uuid,
        session_id: Uuid,
        name: String,
        remote_path: String,
        size: u64,
    },
    Uploading {
        edit_id: Uuid,
        session_id: Uuid,
        name: String,
    },
    Uploaded {
        edit_id: Uuid,
        session_id: Uuid,
        name: String,
        atomic: bool,
    },
    UploadFailed {
        edit_id: Uuid,
        session_id: Uuid,
        name: String,
        reason: String,
        message: String,
    },
    /// The remote file changed after it was opened.
    Conflict {
        edit_id: Uuid,
        session_id: Uuid,
        name: String,
        remote_path: String,
    },
    Declined {
        edit_id: Uuid,
        session_id: Uuid,
        name: String,
    },
    Closed {
        edit_id: Uuid,
        session_id: Uuid,
        name: String,
        /// Local changes were not uploaded and the copy was kept.
        kept_local: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictChoice {
    /// Replace the remote file with my version (explicit authorisation).
    Overwrite,
    /// Leave the server alone and keep my local copy.
    KeepLocal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditorError {
    Remote(SftpError),
    TooLarge,
    LaunchFailed,
    Local,
}

impl EditorError {
    pub fn token(self) -> &'static str {
        match self {
            Self::Remote(e) => e.token(),
            Self::TooLarge => "too_large",
            Self::LaunchFailed => "launch_failed",
            Self::Local => "local_io",
        }
    }
    pub fn message(self) -> &'static str {
        match self {
            Self::Remote(e) => e.message(),
            Self::TooLarge => "The file is too large to edit this way",
            Self::LaunchFailed => {
                "The editor could not be started. Check Settings, SFTP and editor"
            }
            Self::Local => "A local file could not be read or written",
        }
    }
}

impl From<SftpError> for EditorError {
    fn from(e: SftpError) -> Self {
        Self::Remote(e)
    }
}

impl From<EditorError> for crate::error::AppError {
    fn from(e: EditorError) -> Self {
        crate::error::AppError::Remote(e.token(), e.message())
    }
}

/// How an editor is started; replaceable in tests.
pub type Launcher = Arc<dyn Fn(&Path) -> Result<(), ()> + Send + Sync>;
pub type Emitter = Arc<dyn Fn(EditorEvent) + Send + Sync>;

pub struct OpenParams {
    pub session: SessionId,
    pub client: Arc<Client>,
    pub remote_path: String,
    pub temp_root: PathBuf,
    pub launch: Launcher,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedEdit {
    pub edit_id: Uuid,
    pub name: String,
    /// The file was already open in this session; the editor was started again.
    pub already_open: bool,
}

#[derive(Default)]
struct State {
    /// Hash of the content known to equal the remote file.
    synced: Hash,
    /// What we believe the remote file looks like (for conflict detection).
    remote: Option<Expectation>,
    /// Content hash a confirmation prompt is currently open for.
    pending: Option<Hash>,
    answer: Option<(UserAnswer, Hash)>,
    declined: Option<Hash>,
    conflict: Option<Hash>,
    conflict_choice: Option<ConflictChoice>,
    failed: Option<Hash>,
    retry: bool,
    /// (modified, length) of the local file when last looked at.
    seen: Option<(SystemTime, u64)>,
    hashed: Option<(SystemTime, u64)>,
    settle_at: Option<Instant>,
}

struct Edit {
    id: Uuid,
    session: SessionId,
    name: String,
    remote_path: String,
    client: Arc<Client>,
    files: EditFiles,
    state: Mutex<State>,
    wake: Notify,
    stop: AtomicBool,
}

struct Shared {
    registry: Arc<SessionRegistry>,
    lock: LockFlag,
    emit: Emitter,
    timing: Timing,
    edits: Mutex<HashMap<Uuid, Arc<Edit>>>,
}

#[derive(Clone)]
pub struct EditorService {
    shared: Arc<Shared>,
}

fn read_local(path: &Path) -> std::io::Result<Vec<u8>> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > MAX_EDIT_BYTES * 2 {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    std::fs::read(path)
}

fn local_stamp(path: &Path) -> Option<(SystemTime, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

impl EditorService {
    pub fn new(
        registry: Arc<SessionRegistry>,
        lock: LockFlag,
        emit: Emitter,
        timing: Timing,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                registry,
                lock,
                emit,
                timing,
                edits: Mutex::default(),
            }),
        }
    }

    /// Download `remote_path`, make the private copy, start the editor and
    /// begin watching.
    pub async fn open_remote(&self, params: OpenParams) -> Result<OpenedEdit, EditorError> {
        ops::validate_path(&params.remote_path)?;
        let real = params
            .client
            .canonicalize(params.remote_path.clone())
            .await
            .map_err(SftpError::from)?;

        // The same remote file twice in one session: reuse the existing copy.
        let existing = self
            .shared
            .edits
            .lock()
            .unwrap()
            .values()
            .find(|e| e.session == params.session && e.remote_path == real)
            .cloned();
        if let Some(edit) = existing {
            (params.launch)(&edit.files.file).map_err(|()| EditorError::LaunchFailed)?;
            return Ok(OpenedEdit {
                edit_id: edit.id,
                name: edit.name.clone(),
                already_open: true,
            });
        }

        let (content, remote_stamp) =
            fetch(&params.client, &real, self.shared.timing.max_bytes).await?;
        let hash = sha256(&content);
        let id = Uuid::new_v4();
        let files = tempfiles::create(&params.temp_root, &id.to_string(), &real, &content)
            .map_err(|_| EditorError::Local)?;
        let name = files
            .file
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".into());
        if (params.launch)(&files.file).is_err() {
            let _ = tempfiles::remove(&files);
            tracing::warn!(event = "editor.launched", session_id = %params.session, status = "failed", reason = "launch_failed");
            return Err(EditorError::LaunchFailed);
        }
        tracing::info!(event = "editor.launched", session_id = %params.session, status = "ok", bytes = content.len() as u64);

        let edit = Arc::new(Edit {
            id,
            session: params.session,
            name: name.clone(),
            remote_path: real.clone(),
            client: params.client,
            state: Mutex::new(State {
                synced: hash,
                remote: Some(Expectation {
                    stamp: remote_stamp,
                    sha256: Some(hash),
                }),
                seen: local_stamp(&files.file),
                hashed: local_stamp(&files.file),
                ..State::default()
            }),
            files,
            wake: Notify::new(),
            stop: AtomicBool::new(false),
        });
        self.shared.edits.lock().unwrap().insert(id, edit.clone());
        (self.shared.emit)(EditorEvent::Opened {
            edit_id: id,
            session_id: params.session.uuid(),
            name: name.clone(),
            remote_path: real,
        });
        let shared = self.shared.clone();
        tokio::spawn(async move { watch(shared, edit).await });
        Ok(OpenedEdit {
            edit_id: id,
            name,
            already_open: false,
        })
    }

    fn find(&self, id: Uuid) -> Option<Arc<Edit>> {
        self.shared.edits.lock().unwrap().get(&id).cloned()
    }

    /// The user's answer to a confirmation prompt. Accepted **only** while a
    /// prompt for this edit is open, and only once.
    pub fn answer(&self, id: Uuid, answer: UserAnswer) -> bool {
        if self.shared.lock.guard().is_err() {
            return false;
        }
        let Some(edit) = self.find(id) else {
            return false;
        };
        let mut state = edit.state.lock().unwrap();
        let Some(hash) = state.pending.take() else {
            return false;
        };
        state.answer = Some((answer, hash));
        drop(state);
        edit.wake.notify_one();
        true
    }

    pub fn resolve_conflict(&self, id: Uuid, choice: ConflictChoice) -> bool {
        if self.shared.lock.guard().is_err() {
            return false;
        }
        let Some(edit) = self.find(id) else {
            return false;
        };
        let mut state = edit.state.lock().unwrap();
        if state.conflict.is_none() || state.conflict_choice.is_some() {
            return false;
        }
        state.conflict_choice = Some(choice);
        drop(state);
        edit.wake.notify_one();
        true
    }

    /// Try again after a failed upload.
    pub fn retry(&self, id: Uuid) -> bool {
        let Some(edit) = self.find(id) else {
            return false;
        };
        let mut state = edit.state.lock().unwrap();
        if state.failed.is_none() {
            return false;
        }
        state.retry = true;
        drop(state);
        edit.wake.notify_one();
        true
    }

    /// Stop watching one file and remove the copy (unless it holds changes
    /// that were never uploaded).
    pub fn stop(&self, id: Uuid) {
        if let Some(edit) = self.find(id) {
            edit.stop.store(true, Ordering::SeqCst);
            edit.wake.notify_one();
        }
    }

    /// The SSH session ended: stop every edit that belongs to it.
    pub fn end_session(&self, session: SessionId) {
        let edits: Vec<_> = self
            .shared
            .edits
            .lock()
            .unwrap()
            .values()
            .filter(|e| e.session == session)
            .cloned()
            .collect();
        for edit in edits {
            edit.stop.store(true, Ordering::SeqCst);
            edit.wake.notify_one();
        }
    }

    pub fn count(&self, session: SessionId) -> usize {
        self.shared
            .edits
            .lock()
            .unwrap()
            .values()
            .filter(|e| e.session == session)
            .count()
    }
}

/// Download for editing: size-limited, with the remote version recorded before
/// and re-checked after, so a file changing during the download is not
/// mistaken for a consistent copy.
async fn fetch(
    client: &Client,
    path: &str,
    max_bytes: u64,
) -> Result<(Vec<u8>, Stamp), EditorError> {
    for _ in 0..3 {
        let before = stamp(client, path)
            .await?
            .ok_or(EditorError::Remote(SftpError::NotFound))?;
        let meta = client
            .metadata(path.to_owned())
            .await
            .map_err(SftpError::from)?;
        if meta.is_dir() {
            return Err(SftpError::IsADirectory.into());
        }
        if before.size > max_bytes {
            return Err(EditorError::TooLarge);
        }
        let mut file = client
            .open(path.to_owned())
            .await
            .map_err(SftpError::from)?;
        let mut data = Vec::new();
        (&mut file)
            .take(max_bytes + 1)
            .read_to_end(&mut data)
            .await
            .map_err(|_| EditorError::Remote(SftpError::Failed))?;
        if data.len() as u64 > max_bytes {
            return Err(EditorError::TooLarge);
        }
        let after = stamp(client, path).await?;
        if after == Some(before) {
            return Ok((data, before));
        }
    }
    Err(SftpError::RemoteChanged.into())
}

impl Edit {
    fn event_ids(&self) -> (Uuid, Uuid, String) {
        (self.id, self.session.uuid(), self.name.clone())
    }

    fn request(&self, hash: Hash) -> WriteRequest {
        WriteRequest {
            session: self.session,
            remote_path: self.remote_path.clone(),
            content_sha256: hash,
        }
    }

    /// Send `content` to the server. The authorisation is consumed.
    async fn upload(
        &self,
        shared: &Shared,
        auth: UploadAuthorization,
        content: Vec<u8>,
        verify_remote: bool,
    ) {
        let hash = sha256(&content);
        // Defence in depth: the authorisation must be for exactly this.
        if auth.session() != self.session
            || auth.remote_path() != self.remote_path
            || !auth.covers(&hash)
        {
            return;
        }
        let (edit_id, session_id, name) = self.event_ids();
        (shared.emit)(EditorEvent::Uploading {
            edit_id,
            session_id,
            name: name.clone(),
        });
        let expect = if verify_remote {
            self.state.lock().unwrap().remote.clone()
        } else {
            None
        };
        let size = content.len() as u64;
        let cancel = AtomicBool::new(false);
        let result = put_file(
            &self.client,
            std::io::Cursor::new(content),
            &self.remote_path,
            PutOptions {
                overwrite: true,
                expect: expect.as_ref(),
            },
            &cancel,
            &mut |_| {},
        )
        .await;
        let mut state = self.state.lock().unwrap();
        match result {
            Ok(outcome) => {
                state.synced = hash;
                state.remote = Some(Expectation {
                    stamp: outcome.stamp,
                    sha256: Some(hash),
                });
                state.failed = None;
                state.conflict = None;
                state.declined = None;
                drop(state);
                tracing::info!(event = "editor.upload_completed", session_id = %self.session, bytes = size, status = if outcome.atomic { "ok" } else { "skipped" });
                (shared.emit)(EditorEvent::Uploaded {
                    edit_id,
                    session_id,
                    name,
                    atomic: outcome.atomic,
                });
            }
            Err(SftpError::RemoteChanged) => {
                state.conflict = Some(hash);
                drop(state);
                tracing::warn!(event = "editor.conflict_detected", session_id = %self.session);
                (shared.emit)(EditorEvent::Conflict {
                    edit_id,
                    session_id,
                    name,
                    remote_path: self.remote_path.clone(),
                });
            }
            Err(error) => {
                // The local copy is untouched and stays on disk.
                state.failed = Some(hash);
                drop(state);
                tracing::warn!(event = "editor.upload_failed", session_id = %self.session, reason = error.token());
                (shared.emit)(EditorEvent::UploadFailed {
                    edit_id,
                    session_id,
                    name,
                    reason: error.token().to_owned(),
                    message: error.message().to_owned(),
                });
            }
        }
    }
}

async fn watch(shared: Arc<Shared>, edit: Arc<Edit>) {
    loop {
        tokio::select! {
            _ = tokio::time::sleep(shared.timing.poll) => {}
            _ = edit.wake.notified() => {}
        }
        if edit.stop.load(Ordering::SeqCst) {
            break;
        }
        // While the application is locked nothing is asked and nothing is sent.
        if shared.lock.guard().is_err() {
            continue;
        }
        tick(&shared, &edit).await;
    }
    finish(&shared, &edit);
}

fn finish(shared: &Shared, edit: &Edit) {
    let synced = edit.state.lock().unwrap().synced;
    let dirty = match read_local(&edit.files.file) {
        Ok(bytes) => sha256(&bytes) != synced,
        Err(_) => false, // file gone: nothing to keep
    };
    let mut kept_local = dirty;
    if !dirty && tempfiles::remove(&edit.files).is_err() {
        kept_local = false; // still in use by the editor; removed by the next purge
    }
    shared.edits.lock().unwrap().remove(&edit.id);
    let (edit_id, session_id, name) = edit.event_ids();
    (shared.emit)(EditorEvent::Closed {
        edit_id,
        session_id,
        name,
        kept_local,
    });
}

async fn tick(shared: &Shared, edit: &Edit) {
    // 1. A conflict decision.
    let choice = {
        let mut state = edit.state.lock().unwrap();
        state.conflict_choice.take().and_then(|c| {
            let hash = state.conflict.take()?;
            Some((c, hash))
        })
    };
    if let Some((choice, hash)) = choice {
        match choice {
            ConflictChoice::KeepLocal => {
                edit.state.lock().unwrap().declined = Some(hash);
                tracing::info!(event = "editor.upload_declined", session_id = %edit.session, status = "declined");
                emit_declined(shared, edit);
            }
            ConflictChoice::Overwrite => {
                // An explicit decision in the conflict dialog authorises this
                // one upload; it still goes through the registry.
                let authorised = shared
                    .registry
                    .answer_write(&edit.request(hash), UserAnswer::Yes);
                if let Ok(Some(auth)) = authorised
                    && let Ok(bytes) = read_local(&edit.files.file)
                {
                    tracing::info!(event = "editor.upload_approved", session_id = %edit.session, status = "approved");
                    edit.upload(shared, auth, bytes, false).await;
                }
            }
        }
        return;
    }

    // 2. The answer to a confirmation prompt.
    let answer = edit.state.lock().unwrap().answer.take();
    if let Some((answer, hash)) = answer {
        let authorised = shared.registry.answer_write(&edit.request(hash), answer);
        match authorised {
            Ok(Some(auth)) => {
                let kind = if answer == UserAnswer::YesToAll {
                    "yes_to_all"
                } else {
                    "none"
                };
                tracing::info!(event = "editor.upload_approved", session_id = %edit.session, status = "approved", kind = kind);
                match read_local(&edit.files.file) {
                    Ok(bytes) if sha256(&bytes) == hash => {
                        edit.upload(shared, auth, bytes, true).await;
                    }
                    // The file moved on while the prompt was open: look again.
                    _ => edit.state.lock().unwrap().hashed = None,
                }
            }
            _ => {
                edit.state.lock().unwrap().declined = Some(hash);
                tracing::info!(event = "editor.upload_declined", session_id = %edit.session, status = "declined");
                emit_declined(shared, edit);
            }
        }
        return;
    }

    // 3. Waiting for the user: never stack prompts or upload meanwhile.
    {
        let mut state = edit.state.lock().unwrap();
        if state.pending.is_some() || state.conflict.is_some() {
            return;
        }
        if state.retry {
            state.retry = false;
            state.failed = None;
            state.hashed = None;
        }
    }

    // 4. Has the local file changed?
    let now_stamp = local_stamp(&edit.files.file);
    let settled = {
        let mut state = edit.state.lock().unwrap();
        let Some(current) = now_stamp else {
            return; // editor is mid atomic-save, or the file is gone
        };
        if state.seen != Some(current) {
            state.seen = Some(current);
            state.settle_at = Some(Instant::now() + shared.timing.settle);
            return;
        }
        if state.hashed == Some(current) {
            return;
        }
        if state.settle_at.is_some_and(|at| Instant::now() < at) {
            return;
        }
        state.settle_at = None;
        state.hashed = Some(current);
        true
    };
    if !settled {
        return;
    }
    let Ok(bytes) = read_local(&edit.files.file) else {
        return;
    };
    let hash = sha256(&bytes);
    {
        let state = edit.state.lock().unwrap();
        if hash == state.synced {
            return; // saved without a real change
        }
        if state.declined == Some(hash) || state.failed == Some(hash) {
            return; // do not ask or try again for the very same content
        }
    }
    edit.state.lock().unwrap().declined = None;
    tracing::info!(event = "editor.local_change_detected", session_id = %edit.session, bytes = bytes.len() as u64);
    let request = edit.request(hash);
    match shared.registry.evaluate_write(&request) {
        Ok(Decision::Upload(auth)) => {
            edit.upload(shared, auth, bytes, true).await;
        }
        Ok(Decision::Prompt) => {
            edit.state.lock().unwrap().pending = Some(hash);
            tracing::info!(event = "editor.write_confirmation_requested", session_id = %edit.session);
            let (edit_id, session_id, name) = edit.event_ids();
            (shared.emit)(EditorEvent::Confirm {
                edit_id,
                session_id,
                name,
                remote_path: edit.remote_path.clone(),
                size: bytes.len() as u64,
            });
        }
        Err(_) => {} // session gone or locked: nothing is sent
    }
}

fn emit_declined(shared: &Shared, edit: &Edit) {
    let (edit_id, session_id, name) = edit.event_ids();
    (shared.emit)(EditorEvent::Declined {
        edit_id,
        session_id,
        name,
    });
}
