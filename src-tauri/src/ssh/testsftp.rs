//! Placeholder SFTP server handler for tests; filled in with the SFTP workstream.

use russh_sftp::protocol::StatusCode;
use russh_sftp::server::Handler;
use std::path::PathBuf;

pub struct FsHandler {
    #[allow(dead_code)]
    root: PathBuf,
}

impl FsHandler {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
}

impl Handler for FsHandler {
    type Error = StatusCode;
    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }
}
