# FTPeach review notes

Reference: https://github.com/Smooveemaan/FTPeach (Apache-2.0), reviewed at the
`main` branch head on 2026-11-22. **No source code was copied into PeachTerm.**
Only architectural ideas were adopted; PeachTerm's code is written independently.

## What FTPeach does that is worth emulating

| Area          | FTPeach approach                                                                                                     | PeachTerm decision                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Stack         | Tauri 2.12, React 19, Vite 8, Rust edition 2024, pinned toolchain                                                    | Same stack/versions; pinned `rust-toolchain.toml`                                                   |
| Layout        | `src/app`, `src/features/*`, `src/shared`, `src/styles`; Rust split into `protocol`, `security`, `store`, `commands` | Same feature-folder idea, SSH-centred modules                                                       |
| Theme         | CSS variables per palette (`[data-color-scheme]`) and `[data-theme='light']` override                                | Same mechanism, own palette and tokens                                                              |
| SSH host keys | Trust-on-first-use store with atomic `pin_or_verify`, mismatch error stops before credentials are offered            | Same invariant, but first sighting **always** requires explicit approval                            |
| SSH crates    | `russh 0.65` (`ring`, `rsa`, `flate2`, no aws-lc), `russh-sftp`                                                      | Same feature choice (avoids aws-lc/cmake on Windows)                                                |
| Credentials   | DPAPI-backed vault on Windows, `keyring` 3.6 elsewhere                                                               | `keyring` 3.6 on **all** platforms (Credential Manager / Keychain / Secret Service) — one code path |
| IPC ACL       | Per-command permissions in capabilities, "sensitive" permission set                                                  | Own app permissions; minimal capability set                                                         |
| Linting       | ESLint + Prettier, clippy `all = deny` in `[lints]`                                                                  | Same lint policy in `Cargo.toml`                                                                    |
| Lint checks   | Feature boundary checks, secret scanning                                                                             | Planned for later phases                                                                            |

## What PeachTerm deliberately does not take

- FTP/FTPS/WebDAV, transfer queue, updater, tray, MS Store packaging.
- Master-password vault (Argon2 + ChaCha20) — OS keychain is sufficient for PeachTerm's scope.
- Vendored/patched `wry`.
- Artwork, logo, product name.
