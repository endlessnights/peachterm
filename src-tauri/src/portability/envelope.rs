// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! The `.peachbackup` envelope. See `docs/backup-format.md` for the full
//! specification and the rationale for every parameter.
//!
//! ```text
//! offset size  field
//!      0    8  magic            "PEACHBAK"
//!      8    2  format version   u16 big-endian (1)
//!     10    1  KDF id           1 = Argon2id (v1.3)
//!     11    1  AEAD id          1 = XChaCha20-Poly1305
//!     12    4  Argon2 memory    KiB, u32 BE
//!     16    4  Argon2 passes    u32 BE
//!     20    4  Argon2 lanes     u32 BE
//!     24   16  salt             random
//!     40   24  nonce            random
//!     64    8  ciphertext len   u64 BE (includes the 16-byte tag)
//!     72    n  ciphertext || tag
//! ```
//!
//! The first 72 bytes are the AEAD *associated data*: any change to the
//! version, algorithm ids, KDF parameters, salt, nonce or length makes
//! authentication fail. Nothing about the contents (names, hosts, counts) is
//! stored in the clear.

use argon2::password_hash::rand_core::{OsRng, RngCore};
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

pub const MAGIC: &[u8; 8] = b"PEACHBAK";
pub const FORMAT_VERSION: u16 = 1;
const KDF_ARGON2ID: u8 = 1;
const AEAD_XCHACHA20POLY1305: u8 = 1;
pub const HEADER_LEN: usize = 72;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
/// Largest accepted backup file (encrypted). A backup of 10 000 connections
/// is a few MB; this only bounds hostile input.
pub const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// Shortest backup passphrase the application accepts.
pub const MIN_PASSPHRASE_CHARS: usize = 12;

/// Argon2id cost. Chosen from RFC 9106 §4 ("second recommended option":
/// t=3, 64 MiB, 4 lanes): roughly a quarter of a second on a current laptop,
/// 64 MiB per guess for an offline attacker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    pub memory_kib: u32,
    pub passes: u32,
    pub lanes: u32,
}

impl KdfParams {
    pub const DEFAULT: KdfParams = KdfParams {
        memory_kib: 64 * 1024,
        passes: 3,
        lanes: 4,
    };
    /// Cheapest parameters still accepted (OWASP minimum: 19 MiB, t=2, p=1).
    /// Used by tests; refusing anything weaker stops a downgrade.
    pub const MINIMUM: KdfParams = KdfParams {
        memory_kib: 19 * 1024,
        passes: 2,
        lanes: 1,
    };
    const MAX_MEMORY_KIB: u32 = 256 * 1024;
    const MAX_PASSES: u32 = 10;
    const MAX_LANES: u32 = 16;

    /// Checked on the *untrusted* header before any memory is allocated for
    /// key derivation.
    fn validate(self) -> Result<Self, BackupError> {
        let min = Self::MINIMUM;
        let ok = (min.memory_kib..=Self::MAX_MEMORY_KIB).contains(&self.memory_kib)
            && (min.passes..=Self::MAX_PASSES).contains(&self.passes)
            && (min.lanes..=Self::MAX_LANES).contains(&self.lanes)
            // Argon2 requires at least 8 KiB per lane.
            && self.memory_kib >= 8 * self.lanes;
        if ok {
            Ok(self)
        } else {
            Err(BackupError::InvalidParameters)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupError {
    /// Not a PeachTerm backup (wrong magic or far too short).
    NotABackup,
    /// Written by a newer, incompatible version.
    UnsupportedVersion,
    UnsupportedAlgorithm,
    InvalidParameters,
    Truncated,
    TooLarge,
    /// Wrong passphrase *or* modified data: authenticated encryption cannot
    /// (and must not) tell them apart.
    Authentication,
    /// The decrypted payload is not a valid PeachTerm backup document.
    InvalidContent,
    WeakPassphrase,
    Internal,
}

impl BackupError {
    /// Sentence for the user. Deliberately vague about *why* decryption failed.
    pub fn message(self) -> &'static str {
        match self {
            BackupError::NotABackup => "This is not a PeachTerm backup file.",
            BackupError::UnsupportedVersion => {
                "This backup was made by a newer version of PeachTerm. Update PeachTerm to open it."
            }
            BackupError::UnsupportedAlgorithm => {
                "This backup uses an encryption method this version does not support."
            }
            BackupError::InvalidParameters => {
                "This backup file has invalid or unsafe settings and was not opened."
            }
            BackupError::Truncated => "The backup file is incomplete or damaged.",
            BackupError::TooLarge => "The backup file is too large.",
            BackupError::Authentication => {
                "The passphrase is wrong, or the backup file has been damaged or modified."
            }
            BackupError::InvalidContent => "The backup file does not contain valid PeachTerm data.",
            BackupError::WeakPassphrase => "The passphrase must be at least 12 characters long.",
            BackupError::Internal => "The backup could not be processed.",
        }
    }
}

impl From<BackupError> for crate::error::AppError {
    fn from(e: BackupError) -> Self {
        crate::error::AppError::Validation(e.message().into())
    }
}

/// UTF-8, Unicode NFC: the same typed passphrase yields the same key on every OS.
fn passphrase_bytes(passphrase: &str) -> Zeroizing<Vec<u8>> {
    let normalized: Zeroizing<String> = Zeroizing::new(passphrase.nfc().collect());
    Zeroizing::new(normalized.as_bytes().to_vec())
}

fn derive_key(
    passphrase: &str,
    salt: &[u8],
    params: KdfParams,
) -> Result<Zeroizing<[u8; 32]>, BackupError> {
    let argon_params = Params::new(params.memory_kib, params.passes, params.lanes, Some(32))
        .map_err(|_| BackupError::InvalidParameters)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);
    let secret = passphrase_bytes(passphrase);
    let mut key = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(&secret, salt, key.as_mut())
        .map_err(|_| BackupError::Internal)?;
    Ok(key)
}

pub fn check_passphrase(passphrase: &str) -> Result<(), BackupError> {
    if passphrase.nfc().count() < MIN_PASSPHRASE_CHARS {
        return Err(BackupError::WeakPassphrase);
    }
    Ok(())
}

/// Encrypt `plaintext` into a complete `.peachbackup` file image.
pub fn seal(plaintext: &[u8], passphrase: &str, params: KdfParams) -> Result<Vec<u8>, BackupError> {
    let params = params.validate()?;
    check_passphrase(passphrase)?;
    if plaintext.len() as u64 + TAG_LEN as u64 > MAX_FILE_BYTES {
        return Err(BackupError::TooLarge);
    }
    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    OsRng
        .try_fill_bytes(&mut salt)
        .and_then(|()| OsRng.try_fill_bytes(&mut nonce))
        .map_err(|_| BackupError::Internal)?;
    let ct_len = (plaintext.len() + TAG_LEN) as u64;

    let mut header = Vec::with_capacity(HEADER_LEN);
    header.extend_from_slice(MAGIC);
    header.extend_from_slice(&FORMAT_VERSION.to_be_bytes());
    header.push(KDF_ARGON2ID);
    header.push(AEAD_XCHACHA20POLY1305);
    header.extend_from_slice(&params.memory_kib.to_be_bytes());
    header.extend_from_slice(&params.passes.to_be_bytes());
    header.extend_from_slice(&params.lanes.to_be_bytes());
    header.extend_from_slice(&salt);
    header.extend_from_slice(&nonce);
    header.extend_from_slice(&ct_len.to_be_bytes());
    debug_assert_eq!(header.len(), HEADER_LEN);

    let key = derive_key(passphrase, &salt, params)?;
    let cipher =
        XChaCha20Poly1305::new_from_slice(key.as_ref()).map_err(|_| BackupError::Internal)?;
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &header,
            },
        )
        .map_err(|_| BackupError::Internal)?;
    header.extend_from_slice(&ciphertext);
    Ok(header)
}

/// Parsed, *unauthenticated* header. Only used to decide whether to try.
struct Header<'a> {
    params: KdfParams,
    salt: &'a [u8],
    nonce: &'a [u8],
    ciphertext: &'a [u8],
}

fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

fn parse(file: &[u8]) -> Result<Header<'_>, BackupError> {
    if file.len() as u64 > MAX_FILE_BYTES {
        return Err(BackupError::TooLarge);
    }
    if file.len() < MAGIC.len() || &file[..MAGIC.len()] != MAGIC {
        return Err(BackupError::NotABackup);
    }
    if file.len() < HEADER_LEN {
        return Err(BackupError::Truncated);
    }
    let version = u16::from_be_bytes([file[8], file[9]]);
    if version != FORMAT_VERSION {
        return Err(BackupError::UnsupportedVersion);
    }
    if file[10] != KDF_ARGON2ID || file[11] != AEAD_XCHACHA20POLY1305 {
        return Err(BackupError::UnsupportedAlgorithm);
    }
    // Validated here, before `derive_key` allocates anything.
    let params = KdfParams {
        memory_kib: be32(&file[12..16]),
        passes: be32(&file[16..20]),
        lanes: be32(&file[20..24]),
    }
    .validate()?;
    let mut len_bytes = [0u8; 8];
    len_bytes.copy_from_slice(&file[64..72]);
    let ct_len = u64::from_be_bytes(len_bytes);
    if ct_len < TAG_LEN as u64 || ct_len > MAX_FILE_BYTES {
        return Err(BackupError::InvalidParameters);
    }
    let available = (file.len() - HEADER_LEN) as u64;
    if available < ct_len {
        return Err(BackupError::Truncated);
    }
    if available > ct_len {
        // Bytes appended after the authenticated region.
        return Err(BackupError::Authentication);
    }
    Ok(Header {
        params,
        salt: &file[24..40],
        nonce: &file[40..64],
        ciphertext: &file[HEADER_LEN..],
    })
}

/// Cheap structural check (no passphrase, no key derivation).
pub fn inspect(file: &[u8]) -> Result<u16, BackupError> {
    parse(file).map(|_| FORMAT_VERSION)
}

/// Authenticate and decrypt a complete file image.
pub fn open(file: &[u8], passphrase: &str) -> Result<Zeroizing<Vec<u8>>, BackupError> {
    let header = parse(file)?;
    let key = derive_key(passphrase, header.salt, header.params)?;
    let cipher =
        XChaCha20Poly1305::new_from_slice(key.as_ref()).map_err(|_| BackupError::Internal)?;
    cipher
        .decrypt(
            XNonce::from_slice(header.nonce),
            Payload {
                msg: header.ciphertext,
                aad: &file[..HEADER_LEN],
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| BackupError::Authentication)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASS: &str = "correct horse battery";
    const FAST: KdfParams = KdfParams::MINIMUM;

    fn sample() -> Vec<u8> {
        seal(b"{\"hello\":\"world\"}", PASS, FAST).unwrap()
    }

    #[test]
    fn round_trip() {
        let file = sample();
        assert_eq!(&file[..8], MAGIC);
        assert_eq!(
            open(&file, PASS).unwrap().as_slice(),
            b"{\"hello\":\"world\"}"
        );
    }

    #[test]
    fn default_parameters_are_accepted() {
        assert!(KdfParams::DEFAULT.validate().is_ok());
    }

    #[test]
    fn two_backups_of_the_same_data_differ() {
        let a = sample();
        let b = sample();
        assert_ne!(a[24..64], b[24..64], "salt and nonce are random per backup");
        assert_ne!(a, b);
    }

    #[test]
    fn plaintext_is_not_visible() {
        let file = seal(b"secret-host.example.org", PASS, FAST).unwrap();
        assert!(!file.windows(11).any(|w| w == b"secret-host"));
    }

    #[test]
    fn wrong_passphrase_is_rejected() {
        assert_eq!(
            open(&sample(), "another passphrase!").unwrap_err(),
            BackupError::Authentication
        );
    }

    #[test]
    fn unicode_passphrase_is_normalised() {
        // "й" as one code point (NFC) and as "и" + combining breve (NFD).
        let nfc = "пароль-для-бэкапа-\u{439}";
        let nfd = "пароль-для-бэкапа-\u{438}\u{306}";
        let file = seal(b"x", nfc, FAST).unwrap();
        assert!(open(&file, nfd).is_ok());
    }

    #[test]
    fn short_passphrases_are_refused() {
        assert_eq!(
            seal(b"x", "short", FAST).unwrap_err(),
            BackupError::WeakPassphrase
        );
    }

    #[test]
    fn any_flipped_bit_is_detected() {
        let file = sample();
        // Every header byte and a sample of ciphertext bytes (all must fail).
        for i in (0..HEADER_LEN).chain([HEADER_LEN, HEADER_LEN + 3, file.len() - 1]) {
            let mut bad = file.clone();
            bad[i] ^= 0x01;
            assert!(
                open(&bad, PASS).is_err(),
                "bit flip at byte {i} was accepted"
            );
        }
    }

    #[test]
    fn tampered_kdf_parameters_never_decrypt() {
        let mut file = sample();
        // memory 19 MiB -> 20 MiB: structurally valid, but authenticated.
        file[12..16].copy_from_slice(&(20u32 * 1024).to_be_bytes());
        assert_eq!(open(&file, PASS).unwrap_err(), BackupError::Authentication);
    }

    #[test]
    fn truncation_and_trailing_data_are_detected() {
        let file = sample();
        assert_eq!(
            open(&file[..file.len() - 1], PASS).unwrap_err(),
            BackupError::Truncated
        );
        assert_eq!(
            open(&file[..HEADER_LEN], PASS).unwrap_err(),
            BackupError::Truncated
        );
        assert_eq!(open(&file[..40], PASS).unwrap_err(), BackupError::Truncated);
        assert_eq!(open(&file[..4], PASS).unwrap_err(), BackupError::NotABackup);
        assert_eq!(open(&[], PASS).unwrap_err(), BackupError::NotABackup);
        let mut longer = file;
        longer.push(0);
        assert_eq!(
            open(&longer, PASS).unwrap_err(),
            BackupError::Authentication
        );
    }

    #[test]
    fn unsupported_version_and_algorithms_are_rejected() {
        let mut v = sample();
        v[9] = 2;
        assert_eq!(open(&v, PASS).unwrap_err(), BackupError::UnsupportedVersion);
        let mut k = sample();
        k[10] = 9;
        assert_eq!(
            open(&k, PASS).unwrap_err(),
            BackupError::UnsupportedAlgorithm
        );
        let mut a = sample();
        a[11] = 9;
        assert_eq!(
            open(&a, PASS).unwrap_err(),
            BackupError::UnsupportedAlgorithm
        );
        let mut m = sample();
        m[0] = b'X';
        assert_eq!(open(&m, PASS).unwrap_err(), BackupError::NotABackup);
    }

    #[test]
    fn hostile_kdf_parameters_are_refused_before_any_allocation() {
        let base = sample();
        let cases: [(usize, u32); 6] = [
            (12, u32::MAX),    // ~4 TiB of memory
            (12, 1024 * 1024), // 1 GiB
            (12, 1024),        // weaker than the minimum
            (16, 1000),        // absurd pass count
            (16, 0),
            (20, 0),
        ];
        for (offset, value) in cases {
            let mut file = base.clone();
            file[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
            let started = std::time::Instant::now();
            assert_eq!(
                open(&file, PASS).unwrap_err(),
                BackupError::InvalidParameters,
                "offset {offset} value {value}"
            );
            assert!(
                started.elapsed().as_millis() < 50,
                "must fail without running Argon2"
            );
        }
        let mut lanes = base;
        lanes[20..24].copy_from_slice(&1000u32.to_be_bytes());
        assert_eq!(
            open(&lanes, PASS).unwrap_err(),
            BackupError::InvalidParameters
        );
    }

    #[test]
    fn declared_length_larger_than_the_limit_is_refused() {
        let mut file = sample();
        file[64..72].copy_from_slice(&u64::MAX.to_be_bytes());
        assert_eq!(
            open(&file, PASS).unwrap_err(),
            BackupError::InvalidParameters
        );
    }

    #[test]
    fn sealing_with_unsafe_parameters_is_refused() {
        let weak = KdfParams {
            memory_kib: 8,
            passes: 1,
            lanes: 1,
        };
        assert_eq!(
            seal(b"x", PASS, weak).unwrap_err(),
            BackupError::InvalidParameters
        );
    }

    #[test]
    fn inspect_checks_structure_only() {
        assert_eq!(inspect(&sample()).unwrap(), 1);
        assert_eq!(inspect(b"hello").unwrap_err(), BackupError::NotABackup);
    }

    /// Versioned fixture: a backup produced by this format revision must keep
    /// opening. Regenerate only with a deliberate format version bump.
    /// `PEACHTERM_WRITE_FIXTURE=1 cargo test write_fixture -- --ignored`
    #[test]
    #[ignore = "regenerates a committed fixture"]
    fn write_fixture() {
        let file = seal(
            b"{\"fixture\":\"peachterm-backup-v1\"}",
            "fixture-passphrase-v1",
            KdfParams::MINIMUM,
        )
        .unwrap();
        std::fs::write(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/backup-v1-empty.peachbackup"
            ),
            file,
        )
        .unwrap();
    }

    #[test]
    fn fixture_v1_opens() {
        let file = include_bytes!("../../tests/fixtures/backup-v1-empty.peachbackup");
        let plain = open(file, "fixture-passphrase-v1").unwrap();
        assert_eq!(plain.as_slice(), b"{\"fixture\":\"peachterm-backup-v1\"}");
    }
}
