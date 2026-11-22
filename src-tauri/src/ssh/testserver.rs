//! In-process SSH server for integration tests: real sockets, real key
//! exchange, real authentication, a PTY-ish echo shell and (optionally) an SFTP
//! subsystem. Nothing here touches the network beyond 127.0.0.1.

use russh::keys::PrivateKey;
use russh::keys::ssh_key::PublicKey;
use russh::server::{self, Auth, Handler, Msg, Session};
use russh::{Channel, ChannelId, MethodKind, MethodSet};
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

#[derive(Default, Clone)]
pub struct Opts {
    pub users: Vec<(String, String)>,
    pub keys: Vec<PublicKey>,
    /// (user, [(prompt, expected answer)])
    pub kbd: Option<(String, Vec<(String, String)>)>,
    pub host_key: Option<PrivateKey>,
    pub sftp_root: Option<std::path::PathBuf>,
    pub sftp: std::sync::Arc<super::testsftp::SftpOpts>,
}

#[derive(Default)]
pub struct Recorded {
    pub resizes: Mutex<Vec<(u32, u32)>>,
    pub ptys: Mutex<Vec<(String, u32, u32)>>,
    pub input: Mutex<Vec<u8>>,
    pub connections: AtomicUsize,
    pub shells: AtomicUsize,
    /// Every authentication attempt the server saw (any method).
    pub auth_attempts: AtomicUsize,
}

pub struct TestServer {
    pub port: u16,
    pub host_public: PublicKey,
    pub rec: Arc<Recorded>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub fn random_key() -> PrivateKey {
    use russh::keys::ssh_key::private::{Ed25519Keypair, KeypairData};
    let mut seed = [0u8; 32];
    seed[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    seed[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    PrivateKey::new(KeypairData::Ed25519(Ed25519Keypair::from_seed(&seed)), "").unwrap()
}

impl TestServer {
    pub async fn start(opts: Opts) -> Self {
        let host_key = opts.host_key.clone().unwrap_or_else(random_key);
        let host_public = host_key.public_key().clone();
        let mut methods = MethodSet::empty();
        methods.push(MethodKind::Password);
        methods.push(MethodKind::PublicKey);
        methods.push(MethodKind::KeyboardInteractive);
        let config = Arc::new(server::Config {
            keys: vec![host_key],
            methods,
            auth_rejection_time: std::time::Duration::from_millis(10),
            auth_rejection_time_initial: Some(std::time::Duration::from_millis(0)),
            ..Default::default()
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let rec = Arc::new(Recorded::default());
        let opts = Arc::new(opts);
        let rec2 = rec.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                rec2.connections.fetch_add(1, Ordering::SeqCst);
                let handler = H {
                    opts: opts.clone(),
                    rec: rec2.clone(),
                    channels: HashMap::new(),
                    shells: Default::default(),
                };
                let config = config.clone();
                tokio::spawn(async move {
                    if let Ok(running) = server::run_stream(config, stream, handler).await {
                        let _ = running.await;
                    }
                });
            }
        });
        Self {
            port,
            host_public,
            rec,
            task,
        }
    }
}

struct H {
    opts: Arc<Opts>,
    rec: Arc<Recorded>,
    channels: HashMap<ChannelId, Channel<Msg>>,
    shells: std::collections::HashSet<ChannelId>,
}

impl Handler for H {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        self.rec.auth_attempts.fetch_add(1, Ordering::SeqCst);
        let ok = self
            .opts
            .users
            .iter()
            .any(|(u, p)| u == user && p == password);
        Ok(if ok { Auth::Accept } else { Auth::reject() })
    }

    async fn auth_publickey(
        &mut self,
        _user: &str,
        key: server::VerifiedPublicKey<'_>,
    ) -> Result<Auth, Self::Error> {
        self.rec.auth_attempts.fetch_add(1, Ordering::SeqCst);
        let ok = self
            .opts
            .keys
            .iter()
            .any(|k| k.key_data() == key.public_key.key_data());
        Ok(if ok { Auth::Accept } else { Auth::reject() })
    }

    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        user: &str,
        _submethods: &str,
        response: Option<server::Response<'a>>,
    ) -> Result<Auth, Self::Error> {
        self.rec.auth_attempts.fetch_add(1, Ordering::SeqCst);
        let Some((expected_user, steps)) = self.opts.kbd.clone() else {
            return Ok(Auth::reject());
        };
        if user != expected_user {
            return Ok(Auth::reject());
        }
        match response {
            None => Ok(Auth::Partial {
                name: Cow::Borrowed("Verification"),
                instructions: Cow::Borrowed("Answer the questions"),
                prompts: Cow::Owned(
                    steps
                        .iter()
                        .map(|(p, _)| (Cow::Owned(p.clone()), false))
                        .collect(),
                ),
            }),
            Some(answers) => {
                let given: Vec<String> = answers
                    .map(|b| String::from_utf8_lossy(&b).into_owned())
                    .collect();
                let wanted: Vec<&String> = steps.iter().map(|(_, a)| a).collect();
                let ok =
                    given.len() == wanted.len() && given.iter().zip(wanted).all(|(g, w)| g == w);
                Ok(if ok { Auth::Accept } else { Auth::reject() })
            }
        }
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        self.channels.insert(channel.id(), channel);
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        term: &str,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.rec
            .ptys
            .lock()
            .unwrap()
            .push((term.to_owned(), col_width, row_height));
        session.channel_success(channel)
    }

    async fn window_change_request(
        &mut self,
        _channel: ChannelId,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.rec
            .resizes
            .lock()
            .unwrap()
            .push((col_width, row_height));
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.rec.shells.fetch_add(1, Ordering::SeqCst);
        self.shells.insert(channel);
        session.channel_success(channel)?;
        session.data(channel, b"ready\r\n".to_vec())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if !self.shells.contains(&channel) {
            return Ok(());
        }
        self.rec.input.lock().unwrap().extend_from_slice(data);
        if data == b"flood\n" {
            for _ in 0..64 {
                session.data(channel, vec![b'x'; 32 * 1024])?;
            }
            session.data(channel, b"\r\nflood-done\r\n".to_vec())
        } else {
            session.data(channel, data.to_vec())
        }
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name == "sftp" && self.opts.sftp_root.is_some() {
            let Some(ch) = self.channels.remove(&channel) else {
                return session.channel_failure(channel);
            };
            session.channel_success(channel)?;
            let root = self.opts.sftp_root.clone().unwrap();
            let sftp = self.opts.sftp.clone();
            tokio::spawn(async move {
                russh_sftp::server::run(
                    ch.into_stream(),
                    super::testsftp::FsHandler::new(root, sftp),
                )
                .await;
            });
            Ok(())
        } else {
            session.channel_failure(channel)
        }
    }
}
