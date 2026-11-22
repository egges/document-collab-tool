//! Git-backed synchronization for document workspaces.
//!
//! A workspace is a directory of plain files (Markdown pages, JSON metadata
//! and database rows) inside a git repository. [`SyncEngine::sync`] commits
//! local edits, merges in what other devices pushed, resolves every conflict
//! automatically and pushes the result. Users never see git.
//!
//! See `docs/sync-design.md` in the repository for the design and the
//! guarantees the test suite checks.

pub mod clock;
pub mod conflicts;
mod engine;
mod error;
pub mod git;
pub mod json_merge;
pub mod layout;
mod merge;
pub mod text_merge;
pub mod workspace;

pub use clock::{Clock, ManualClock, SystemClock};
pub use engine::{
    DEVICE_REFS, OTHER_CHANGES_LABEL, PageWrite, RemoteLayout, SyncConfig, SyncEngine, SyncReport,
    prepare_folder_remote,
};
pub use error::{Error, Result};
pub use git::{CliGit, GitBackend};
pub use merge::{Resolution, ResolvedConflict};
pub use workspace::Workspace;
