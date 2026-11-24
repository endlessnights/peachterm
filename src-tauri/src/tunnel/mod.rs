// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! SSH local port forwarding (`ssh -L`). See docs/tunnels.md.

pub mod engine;
#[cfg(test)]
mod integration;
pub mod model;
pub mod store;

pub use engine::{TunnelEngine, TunnelState, TunnelStatus};
pub use model::{TunnelDef, TunnelInput};
pub use store::TunnelStore;
