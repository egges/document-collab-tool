//! The narrow set of Git operations the sync engine relies on.
//!
//! [`CliGit`] implements them by running a `git` binary the application ships
//! with. Keeping the engine behind this trait means the backend can later be
//! swapped (for example for gitoxide) and verified against the same tests, and
//! it lets tests wrap the real backend to inject crashes and network failures.

mod cli;

use std::fmt;
use std::path::Path;

pub use cli::{CliGit, GitCall};

use crate::Result;

/// A Git object id (hex encoded).
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Oid(String);

impl Oid {
    pub fn new(hex: impl Into<String>) -> Self {
        Oid(hex.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn short(&self) -> &str {
        &self.0[..self.0.len().min(8)]
    }
}

impl fmt::Display for Oid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for Oid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Oid({})", self.short())
    }
}

/// An author's or committer's identity plus timestamp for a commit.
#[derive(Debug, Clone)]
pub struct Signature {
    pub name: String,
    pub email: String,
    /// Seconds since the Unix epoch.
    pub time: i64,
}

/// A blob referenced from a tree or index stage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobRef {
    pub mode: String,
    pub oid: Oid,
}

/// A file in a tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeEntry {
    pub mode: String,
    pub oid: Oid,
    pub path: String,
}

/// A path Git could not merge on its own, with the version from each side.
/// A missing side means the file does not exist there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictEntry {
    pub path: String,
    pub base: Option<BlobRef>,
    pub ours: Option<BlobRef>,
    pub theirs: Option<BlobRef>,
}

/// Result of merging two commits without touching the working tree.
#[derive(Debug, Clone)]
pub struct MergeTreeResult {
    /// The merged tree. Conflicted paths still need to be resolved.
    pub tree: Oid,
    pub conflicts: Vec<ConflictEntry>,
}

/// Result of a three-way merge of a single text file.
#[derive(Debug, Clone)]
pub struct TextMerge {
    pub content: Vec<u8>,
    pub conflicts: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TreeEdit {
    Upsert { path: String, mode: String, oid: Oid },
    Remove { path: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitInfo {
    pub oid: Oid,
    pub time: i64,
    /// Who wrote it: the person, or the device when nobody was signed in.
    pub author: String,
    pub author_email: String,
    /// The author's id, from the commit's `Person-Id` trailer
    /// ([`crate::PERSON_ID_TRAILER`]), when it has one.
    pub person_id: Option<String>,
    /// The device it was made on (the author again, in commits from before
    /// devices were recorded).
    pub committer: String,
    pub committer_email: String,
}

/// Whether git's error output (from a fetch or push that failed with
/// [`crate::Error::Network`]) says the remote refused this device: no
/// credentials, wrong ones, or an account without access. Hosts such as
/// GitHub answer "not found" for a private repository the account can't
/// see, so that counts too. Everything else, such as no network or a
/// server that's down, means try again later.
pub fn is_access_denied(stderr: &str) -> bool {
    let text = stderr.to_lowercase();
    [
        "could not read username",
        "could not read password",
        "authentication failed",
        "invalid username or",
        "returned error: 401",
        "returned error: 403",
        "permission denied (publickey",
        "repository not found",
        "access to repository not granted",
    ]
    .iter()
    .any(|needle| text.contains(needle))
        || (text.contains("permission to") && text.contains("denied to"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushResult {
    Pushed,
    /// The remote refused the update, usually because it moved on.
    Rejected(String),
}

pub trait GitBackend: Send + Sync {
    /// The backend's git version string, e.g. `2.56.1`.
    fn version(&self) -> Result<String>;

    /// Create a new repository in `dir` with `branch` as its unborn HEAD.
    fn init(&self, dir: &Path, branch: &str) -> Result<()>;
    fn set_remote_url(&self, repo: &Path, remote: &str, url: &str) -> Result<()>;

    /// The ref HEAD points to, or `None` when HEAD is detached.
    fn head_ref(&self, repo: &Path) -> Result<Option<String>>;
    /// Resolve a revision (`refs/heads/main`, `<oid>:<path>`, ...) to an id.
    fn resolve(&self, repo: &Path, rev: &str) -> Result<Option<Oid>>;

    /// Stage every change in the working tree, including deletions.
    fn stage_all(&self, repo: &Path) -> Result<()>;
    /// Write the index as a tree object.
    fn write_index_tree(&self, repo: &Path) -> Result<Oid>;
    fn commit_tree(
        &self,
        repo: &Path,
        tree: &Oid,
        parents: &[Oid],
        message: &str,
        author: &Signature,
        committer: &Signature,
    ) -> Result<Oid>;
    /// Move `refname` to `new`. With `expected_old`, only if it currently
    /// points there.
    fn update_ref(&self, repo: &Path, refname: &str, new: &Oid, expected_old: Option<&Oid>) -> Result<()>;
    /// Update index and working tree from tree-ish `from` to `to`, refusing
    /// (with [`crate::Error::WorkingTreeChanged`]) to overwrite files that
    /// changed on disk.
    fn checkout(&self, repo: &Path, from: &Oid, to: &Oid) -> Result<()>;

    /// Fetch `branch` from `remote` and return its tip, or `None` when the
    /// remote does not have the branch yet. Fails with
    /// [`crate::Error::Network`] when the remote is unreachable.
    fn fetch(&self, repo: &Path, remote: &str, branch: &str) -> Result<Option<Oid>>;
    fn push(&self, repo: &Path, remote: &str, commit: &Oid, branch: &str) -> Result<PushResult>;

    /// Create a bare repository in `dir` to use as a folder remote (see
    /// [`GitBackend::publish_to_folder`]), with everything that would make
    /// git rewrite shared files turned off.
    fn init_folder_remote(&self, dir: &Path) -> Result<()>;
    /// The URL or path `remote` points to, or `None` when there's no such
    /// remote.
    fn remote_url(&self, repo: &Path, remote: &str) -> Result<Option<String>>;
    /// The refs on `remote` whose names start with `prefix` (e.g.
    /// `refs/heads/devices/`), sorted by name. Fails with
    /// [`crate::Error::Network`] when the remote is unreachable.
    fn remote_refs(&self, repo: &Path, remote: &str, prefix: &str) -> Result<Vec<(String, Oid)>>;
    /// Publish `commit` as `refname` in the folder remote at `folder`
    /// without git's receive-pack, which refuses to work while any other
    /// ref points at objects that haven't arrived yet. Writes one new pack
    /// (everything reachable from `commit` but not from `exclude`, a commit
    /// the folder already has), then the ref, each atomically. Fails with
    /// [`crate::Error::Network`] when the folder can't be written.
    fn publish_to_folder(
        &self,
        repo: &Path,
        folder: &Path,
        commit: &Oid,
        exclude: Option<&Oid>,
        refname: &str,
    ) -> Result<()>;

    fn is_ancestor(&self, repo: &Path, ancestor: &Oid, descendant: &Oid) -> Result<bool>;
    fn merge_base(&self, repo: &Path, a: &Oid, b: &Oid) -> Result<Option<Oid>>;
    /// Merge two commits entirely in the object database.
    fn merge_trees(&self, repo: &Path, ours: &Oid, theirs: &Oid) -> Result<MergeTreeResult>;
    /// Three-way merge of three blobs. Conflict markers use `marker_size`
    /// characters and the given labels (ours, base, theirs).
    fn merge_text(
        &self,
        repo: &Path,
        base: &Oid,
        ours: &Oid,
        theirs: &Oid,
        labels: [&str; 3],
        marker_size: usize,
    ) -> Result<TextMerge>;

    fn read_blob(&self, repo: &Path, oid: &Oid) -> Result<Vec<u8>>;
    fn write_blob(&self, repo: &Path, data: &[u8]) -> Result<Oid>;
    /// All files in `treeish`, optionally limited to `prefix` (a file or
    /// directory path).
    fn list_tree(&self, repo: &Path, treeish: &Oid, prefix: Option<&str>) -> Result<Vec<TreeEntry>>;
    /// Paths that differ between two tree-ishes (renames not detected).
    fn changed_paths(&self, repo: &Path, from: &Oid, to: &Oid) -> Result<Vec<String>>;
    /// Apply `edits` to tree `base` and write the resulting tree.
    fn edit_tree(&self, repo: &Path, base: &Oid, edits: &[TreeEdit]) -> Result<Oid>;
    /// Non-merge commits reachable from `until` but not from `since` that
    /// touch `path`, newest first.
    fn path_history(
        &self,
        repo: &Path,
        since: Option<&Oid>,
        until: &Oid,
        path: &str,
    ) -> Result<Vec<CommitInfo>>;
}

#[cfg(test)]
mod access_tests {
    use super::is_access_denied;

    #[test]
    fn tells_refused_access_from_unreachable() {
        for refused in [
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
            "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/a/b.git/'",
            "fatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403",
            "remote: Permission to a/b.git denied to someone.\nfatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403",
            "remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found",
            "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
            "remote: Write access to repository not granted.",
        ] {
            assert!(is_access_denied(refused), "{refused}");
        }
        for unreachable in [
            "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com",
            "fatal: unable to access 'https://github.com/a/b.git/': Failed to connect to github.com port 443",
            "ssh: connect to host github.com port 22: Operation timed out",
            "fatal: '/Volumes/Drive/notes.git' does not appear to be a git repository",
            "fatal: unable to access 'https://example.com/a.git/': The requested URL returned error: 502",
        ] {
            assert!(!is_access_denied(unreachable), "{unreachable}");
        }
    }
}
