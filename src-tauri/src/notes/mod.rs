// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Server notes & documentation attached to saved SSH connections.
//! See `docs/notes.md` for the user-facing description and the security model.

pub mod local;
pub mod model;
pub mod portable;
pub mod remote;
pub mod store;

pub use model::NoteKind;
pub use store::NotesStore;
