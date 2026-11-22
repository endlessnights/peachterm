//! A small SFTP server over a directory, for tests. Paths are virtual: `/`
//! is the root directory handed to [`FsHandler::new`], and nothing outside it
//! can be reached. Knobs on [`SftpOpts`] let tests simulate servers without
//! `posix-rename`, interrupted writes and slow transfers.

use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, FileMode, Handle, Name, OpenFlags, Packet, SftpHandle,
    SftpString, Status, StatusCode, Version,
};
use russh_sftp::server::{Handler, StatusReply};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
pub struct SftpOpts {
    /// Advertise and implement `posix-rename@openssh.com`.
    pub posix_rename: bool,
    /// After this many bytes were written through one server, writes fail.
    pub fail_write_after: Option<u64>,
    /// Refuse every change (create, write, mkdir, remove, rename) like a read-only account.
    pub readonly: bool,
    pub written: AtomicU64,
}

enum Open {
    File(std::fs::File),
    Dir { entries: Vec<File>, sent: bool },
}

pub struct FsHandler {
    root: PathBuf,
    opts: Arc<SftpOpts>,
    handles: HashMap<String, Open>,
    next: u64,
}

impl FsHandler {
    pub fn new(root: PathBuf, opts: Arc<SftpOpts>) -> Self {
        Self {
            root,
            opts,
            handles: HashMap::new(),
            next: 0,
        }
    }

    /// Virtual path → real path; `..` can never climb above the root.
    fn real(&self, path: &SftpString) -> PathBuf {
        let mut parts: Vec<String> = Vec::new();
        for part in path.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                other => parts.push(other.to_owned()),
            }
        }
        parts.iter().fold(self.root.clone(), |p, c| p.join(c))
    }

    fn virtual_of(path: &SftpString) -> String {
        let mut parts: Vec<String> = Vec::new();
        for part in path.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                other => parts.push(other.to_owned()),
            }
        }
        format!("/{}", parts.join("/"))
    }

    fn new_handle(&mut self, open: Open) -> Handle {
        self.next += 1;
        let key = format!("h{}", self.next);
        self.handles.insert(key.clone(), open);
        Handle {
            id: 0,
            handle: SftpHandle::from(key),
        }
    }

    fn key(handle: &SftpHandle) -> String {
        String::from_utf8_lossy(handle.as_bytes()).into_owned()
    }
}

fn attrs_of(meta: &std::fs::Metadata) -> FileAttributes {
    let mut attrs = FileAttributes::empty();
    attrs.size = Some(meta.len());
    attrs.mtime = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as u32);
    attrs.atime = attrs.mtime;
    let perm = permission_bits(meta);
    attrs.permissions = Some(
        perm | if meta.is_dir() {
            FileMode::DIR.bits()
        } else {
            FileMode::REG.bits()
        },
    );
    attrs
}

#[cfg(unix)]
fn permission_bits(meta: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o7777
}

#[cfg(not(unix))]
fn permission_bits(meta: &std::fs::Metadata) -> u32 {
    if meta.is_dir() {
        0o755
    } else if meta.permissions().readonly() {
        0o444
    } else {
        0o644
    }
}

fn err(e: &std::io::Error) -> StatusCode {
    match e.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
        std::io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
        _ => StatusCode::Failure,
    }
}

fn ok(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".into(),
        language_tag: "en-US".into(),
    }
}

fn one(id: u32, name: &str, attrs: FileAttributes) -> Name {
    Name {
        id,
        files: vec![File::new(name, attrs)],
    }
}

fn set_mode(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode & 0o7777));
    }
    #[cfg(not(unix))]
    {
        if let Ok(meta) = std::fs::metadata(path) {
            let mut p = meta.permissions();
            p.set_readonly(mode & 0o200 == 0);
            let _ = std::fs::set_permissions(path, p);
        }
    }
}

impl Handler for FsHandler {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        let mut v = Version::new();
        if self.opts.posix_rename {
            v.extensions
                .insert("posix-rename@openssh.com".into(), "1".into());
        }
        Ok(v)
    }

    async fn open(
        &mut self,
        id: u32,
        filename: SftpString,
        pflags: OpenFlags,
        attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        if self.opts.readonly
            && pflags.intersects(OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::APPEND)
        {
            return Err(StatusCode::PermissionDenied);
        }
        let path = self.real(&filename);
        let mut options = std::fs::OpenOptions::new();
        options
            .read(pflags.contains(OpenFlags::READ))
            .write(pflags.contains(OpenFlags::WRITE))
            .append(pflags.contains(OpenFlags::APPEND));
        if pflags.contains(OpenFlags::CREATE) {
            if pflags.contains(OpenFlags::EXCLUDE) {
                options.create_new(true);
            } else {
                options.create(true);
            }
        }
        if pflags.contains(OpenFlags::TRUNCATE) {
            options.truncate(true);
        }
        let existed = path.exists();
        let file = options.open(&path).map_err(|e| err(&e))?;
        if !existed && let Some(mode) = attrs.permissions {
            set_mode(&path, mode);
        }
        let mut h = self.new_handle(Open::File(file));
        h.id = id;
        Ok(h)
    }

    async fn close(&mut self, id: u32, handle: SftpHandle) -> Result<Status, Self::Error> {
        self.handles.remove(&Self::key(&handle));
        Ok(ok(id))
    }

    async fn read(
        &mut self,
        id: u32,
        handle: SftpHandle,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let Some(Open::File(file)) = self.handles.get_mut(&Self::key(&handle)) else {
            return Err(StatusCode::Failure);
        };
        file.seek(SeekFrom::Start(offset)).map_err(|e| err(&e))?;
        let mut buf = vec![0u8; len.min(256 * 1024) as usize];
        let n = file.read(&mut buf).map_err(|e| err(&e))?;
        if n == 0 {
            return Err(StatusCode::Eof);
        }
        buf.truncate(n);
        Ok(Data { id, data: buf })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: SftpHandle,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        if let Some(limit) = self.opts.fail_write_after {
            let total = self
                .opts
                .written
                .fetch_add(data.len() as u64, Ordering::SeqCst);
            if total >= limit {
                return Err(StatusCode::Failure);
            }
        }
        let Some(Open::File(file)) = self.handles.get_mut(&Self::key(&handle)) else {
            return Err(StatusCode::Failure);
        };
        file.seek(SeekFrom::Start(offset)).map_err(|e| err(&e))?;
        file.write_all(&data).map_err(|e| err(&e))?;
        Ok(ok(id))
    }

    async fn lstat(&mut self, id: u32, path: SftpString) -> Result<Attrs, Self::Error> {
        self.stat(id, path).await
    }

    async fn stat(&mut self, id: u32, path: SftpString) -> Result<Attrs, Self::Error> {
        let meta = std::fs::metadata(self.real(&path)).map_err(|e| err(&e))?;
        Ok(Attrs {
            id,
            attrs: attrs_of(&meta),
        })
    }

    async fn fstat(&mut self, id: u32, handle: SftpHandle) -> Result<Attrs, Self::Error> {
        let Some(Open::File(file)) = self.handles.get(&Self::key(&handle)) else {
            return Err(StatusCode::Failure);
        };
        let meta = file.metadata().map_err(|e| err(&e))?;
        Ok(Attrs {
            id,
            attrs: attrs_of(&meta),
        })
    }

    async fn setstat(
        &mut self,
        id: u32,
        path: SftpString,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let real = self.real(&path);
        if !real.exists() {
            return Err(StatusCode::NoSuchFile);
        }
        if let Some(mode) = attrs.permissions {
            set_mode(&real, mode);
        }
        Ok(ok(id))
    }

    async fn fsetstat(
        &mut self,
        id: u32,
        _handle: SftpHandle,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        Ok(ok(id))
    }

    async fn opendir(&mut self, id: u32, path: SftpString) -> Result<Handle, Self::Error> {
        let real = self.real(&path);
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(&real).map_err(|e| err(&e))? {
            let entry = entry.map_err(|e| err(&e))?;
            let Ok(meta) = entry.metadata() else { continue };
            entries.push(File::new(
                entry.file_name().to_string_lossy().into_owned(),
                attrs_of(&meta),
            ));
        }
        entries.sort_by(|a, b| a.filename.as_bytes().cmp(b.filename.as_bytes()));
        let mut h = self.new_handle(Open::Dir {
            entries,
            sent: false,
        });
        h.id = id;
        Ok(h)
    }

    async fn readdir(&mut self, id: u32, handle: SftpHandle) -> Result<Name, Self::Error> {
        let Some(Open::Dir { entries, sent }) = self.handles.get_mut(&Self::key(&handle)) else {
            return Err(StatusCode::Failure);
        };
        if *sent {
            return Err(StatusCode::Eof);
        }
        *sent = true;
        Ok(Name {
            id,
            files: std::mem::take(entries),
        })
    }

    async fn remove(&mut self, id: u32, filename: SftpString) -> Result<Status, Self::Error> {
        if self.opts.readonly {
            return Err(StatusCode::PermissionDenied);
        }
        std::fs::remove_file(self.real(&filename)).map_err(|e| err(&e))?;
        Ok(ok(id))
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: SftpString,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        if self.opts.readonly {
            return Err(StatusCode::PermissionDenied);
        }
        std::fs::create_dir(self.real(&path)).map_err(|e| err(&e))?;
        Ok(ok(id))
    }

    async fn rmdir(&mut self, id: u32, path: SftpString) -> Result<Status, Self::Error> {
        std::fs::remove_dir(self.real(&path)).map_err(|e| err(&e))?;
        Ok(ok(id))
    }

    async fn realpath(&mut self, id: u32, path: SftpString) -> Result<Name, Self::Error> {
        let virt = Self::virtual_of(&path);
        Ok(one(id, &virt, FileAttributes::dummy()))
    }

    /// SFTP v3 `rename` refuses to replace an existing file.
    async fn rename(
        &mut self,
        id: u32,
        oldpath: SftpString,
        newpath: SftpString,
    ) -> Result<Status, Self::Error> {
        let to = self.real(&newpath);
        if to.exists() {
            return Err(StatusCode::Failure);
        }
        std::fs::rename(self.real(&oldpath), to).map_err(|e| err(&e))?;
        Ok(ok(id))
    }

    async fn readlink(&mut self, _id: u32, _path: SftpString) -> Result<Name, Self::Error> {
        Err(StatusCode::NoSuchFile)
    }

    async fn extended(
        &mut self,
        id: u32,
        request: String,
        data: Vec<u8>,
    ) -> Result<Packet, Self::Error> {
        if request == "posix-rename@openssh.com" && self.opts.posix_rename {
            let mut strings = Vec::new();
            let mut rest = data.as_slice();
            while rest.len() >= 4 {
                let n = u32::from_be_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
                if rest.len() < 4 + n {
                    return Err(StatusCode::BadMessage);
                }
                strings.push(String::from_utf8_lossy(&rest[4..4 + n]).into_owned());
                rest = &rest[4 + n..];
            }
            if strings.len() != 2 {
                return Err(StatusCode::BadMessage);
            }
            std::fs::rename(self.real(&strings[0]), self.real(&strings[1])).map_err(|e| err(&e))?;
            return Ok(Packet::Status(ok(id)));
        }
        Err(StatusCode::OpUnsupported)
    }
}

/// Reply type used by the library; re-exported so the compiler sees the
/// `Into<StatusReply>` bound is met by `StatusCode`.
#[allow(dead_code)]
type _Reply = StatusReply;
