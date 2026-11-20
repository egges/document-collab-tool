use std::path::PathBuf;

use thiserror::Error;

/// Everything that can go wrong while reading, writing or syncing a workspace.
#[derive(Debug, Error)]
pub enum Error {
    /// A git command exited unsuccessfully.
    #[error("`git {command}` failed (exit code {status:?}): {stderr}")]
    Git {
        command: String,
        status: Option<i32>,
        stderr: String,
    },

    /// The remote could not be reached (offline, DNS, authentication, ...).
    #[error("could not reach the remote: {0}")]
    Network(String),

    /// Files changed on disk while the engine was updating the working tree.
    /// The sync loop handles this itself by committing and retrying.
    #[error("the working tree changed while syncing: {0}")]
    WorkingTreeChanged(String),

    /// The remote kept moving while we tried to push.
    #[error("push was rejected {0} times in a row; try again later")]
    PushRejected(u32),

    #[error("git {found} is too old; version {required} or newer is required")]
    UnsupportedGitVersion { found: String, required: String },

    /// The repository is in a state the engine does not manage
    /// (detached HEAD, wrong branch, missing commits, ...).
    #[error("invalid repository state: {0}")]
    InvalidState(String),

    /// A workspace file could not be parsed.
    #[error("invalid workspace data in {path}: {message}")]
    InvalidData { path: String, message: String },

    #[error("I/O error at {}: {source}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// Raised by test doubles and other custom [`crate::GitBackend`]s.
    #[error("{0}")]
    Other(String),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

pub(crate) trait IoContext<T> {
    fn at(self, path: impl Into<PathBuf>) -> Result<T>;
}

impl<T> IoContext<T> for std::io::Result<T> {
    fn at(self, path: impl Into<PathBuf>) -> Result<T> {
        self.map_err(|source| Error::Io {
            path: path.into(),
            source,
        })
    }
}
