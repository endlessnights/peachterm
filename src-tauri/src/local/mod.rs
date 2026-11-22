// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Native local terminals (ConPTY / POSIX PTY through `portable-pty`).
//!
//! * [`profiles`] decides which shells exist and how each one is started.
//! * [`session`] owns a running pseudo-terminal.
//!
//! The renderer names a profile by id only; it never supplies a program or a
//! command line.

pub mod profiles;
pub mod session;
