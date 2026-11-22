use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde_json::json;

use crate::error::IoContext;
use crate::git::{GitBackend, Oid, PushResult, Signature};
use crate::merge::{self, ResolvedConflict};
use crate::{Clock, Error, Result, Workspace, conflicts, json_merge, layout, text_merge};

/// Label for the on-disk side when [`SyncEngine::write_page_body`] merges.
pub const OTHER_CHANGES_LABEL: &str = "Changed elsewhere";

/// Settings for one device's copy of a workspace.
#[derive(Debug, Clone)]
pub struct SyncConfig {
    pub remote: String,
    pub branch: String,
    /// Shown in conflict blocks and conflict-copy names, e.g. "Arjan's MacBook".
    pub device_name: String,
    pub author_name: String,
    pub author_email: String,
    /// How many fetch/merge/push rounds to try before giving up when other
    /// devices keep pushing in between.
    pub max_attempts: u32,
    /// Git lock files older than this are assumed to be left behind by a
    /// crashed process and are removed.
    pub stale_lock_age: Duration,
}

impl SyncConfig {
    pub fn new(device_name: impl Into<String>) -> Self {
        let device_name = device_name.into();
        Self {
            remote: "origin".into(),
            branch: "main".into(),
            author_email: format!("{}@devices.invalid", layout::slug(&device_name)),
            author_name: device_name.clone(),
            device_name,
            max_attempts: 8,
            stale_lock_age: Duration::from_secs(60),
        }
    }
}

/// What a call to [`SyncEngine::sync`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncReport {
    /// Local edits were committed.
    pub committed: bool,
    /// Remote changes were applied without needing a merge.
    pub fast_forwarded: bool,
    /// Local and remote changes were merged.
    pub merged: bool,
    /// Local commits were published to the remote.
    pub pushed: bool,
    /// The remote was unreachable. Local edits are committed and will be
    /// pushed on a later sync.
    pub offline: bool,
    /// What git said when the remote was unreachable, for showing the user
    /// (no network, no remote set, authentication failed, ...).
    pub offline_reason: Option<String>,
    /// Conflicts that were resolved automatically during the merge.
    pub conflicts: Vec<ResolvedConflict>,
    /// Stale git lock files that were removed before syncing.
    pub removed_locks: Vec<String>,
}

/// What [`SyncEngine::write_page_body`] wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PageWrite {
    /// The page was unchanged on disk, so `body` was written as given.
    Written,
    /// The page changed on disk since `base` (a sync, an AI agent or another
    /// program). Both sets of changes were merged, and `body` is what was
    /// written. Lines both sides changed are in `conflicts` conflict blocks.
    Merged { body: String, conflicts: u32 },
    /// The page no longer exists (a sync deleted it), so nothing was written.
    PageGone,
}

/// Synchronizes a workspace directory with a git remote.
///
/// All methods are safe to call from several processes at once (for example
/// the desktop app and an MCP server): they serialize on a lock file.
pub struct SyncEngine {
    git: Arc<dyn GitBackend>,
    root: PathBuf,
    config: SyncConfig,
    clock: Arc<dyn Clock>,
    /// Name and email for new commits; starts as the config's, and changes
    /// with [`SyncEngine::set_author`] when the user signs in or out.
    author: std::sync::Mutex<(String, String)>,
}

impl SyncEngine {
    fn new(git: Arc<dyn GitBackend>, root: PathBuf, config: SyncConfig, clock: Arc<dyn Clock>) -> Self {
        let author = (config.author_name.clone(), config.author_email.clone());
        Self {
            git,
            root,
            config,
            clock,
            author: std::sync::Mutex::new(author),
        }
    }

    /// Create a new, empty workspace at `root`.
    pub fn init(
        git: Arc<dyn GitBackend>,
        root: impl Into<PathBuf>,
        config: SyncConfig,
        clock: Arc<dyn Clock>,
    ) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root).at(&root)?;
        git.init(&root, &config.branch)?;
        let engine = Self::new(git, root, config, clock);
        engine.write_initial_files()?;
        engine.commit_local("Create workspace")?;
        Ok(engine)
    }

    /// Set up a workspace at `root` that syncs with `url`. If the remote is
    /// empty, a new workspace is created and published on the next sync.
    pub fn clone_remote(
        git: Arc<dyn GitBackend>,
        url: &str,
        root: impl Into<PathBuf>,
        config: SyncConfig,
        clock: Arc<dyn Clock>,
    ) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root).at(&root)?;
        git.init(&root, &config.branch)?;
        git.set_remote_url(&root, &config.remote, url)?;
        let engine = Self::new(git, root, config, clock);
        match engine
            .git
            .fetch(&engine.root, &engine.config.remote, &engine.config.branch)?
        {
            Some(remote) => {
                let empty_tree = engine.git.write_index_tree(&engine.root)?;
                engine.git.checkout(&engine.root, &empty_tree, &remote)?;
                engine
                    .git
                    .update_ref(&engine.root, &engine.branch_ref(), &remote, None)?;
            }
            None => {
                engine.write_initial_files()?;
                engine.commit_local("Create workspace")?;
            }
        }
        Ok(engine)
    }

    /// Open an existing workspace.
    pub fn open(
        git: Arc<dyn GitBackend>,
        root: impl Into<PathBuf>,
        config: SyncConfig,
        clock: Arc<dyn Clock>,
    ) -> Result<Self> {
        let engine = Self::new(git, root.into(), config, clock);
        let expected = engine.branch_ref();
        match engine.git.head_ref(&engine.root)? {
            Some(head) if head == expected => {}
            other => {
                return Err(Error::InvalidState(format!(
                    "HEAD is {other:?}, expected it to point at {expected}"
                )));
            }
        }
        if engine.head()?.is_none() {
            return Err(Error::InvalidState(format!("{expected} has no commits")));
        }
        Ok(engine)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The settings the engine was opened with. The author may have changed
    /// since; see [`SyncEngine::author`].
    pub fn config(&self) -> &SyncConfig {
        &self.config
    }

    /// Name and email that new commits get.
    pub fn author(&self) -> (String, String) {
        self.author.lock().unwrap().clone()
    }

    /// Who new commits are by from now on, e.g. after signing in. Earlier
    /// commits keep their author.
    pub fn set_author(&self, name: impl Into<String>, email: impl Into<String>) {
        *self.author.lock().unwrap() = (name.into(), email.into());
    }

    pub fn set_remote(&self, url: &str) -> Result<()> {
        self.git.set_remote_url(&self.root, &self.config.remote, url)
    }

    /// The current local commit.
    pub fn head(&self) -> Result<Option<Oid>> {
        self.git.resolve(&self.root, &self.branch_ref())
    }

    /// Commit all edits in the working tree, if there are any. Call this
    /// shortly after the user (or an AI agent) changes something: commit
    /// times decide which edit wins when two devices change the same field.
    pub fn commit_local(&self, message: &str) -> Result<Option<Oid>> {
        let _lock = self.lock()?;
        self.commit_locked(message)
    }

    /// Write a page's body that was edited starting from `base`, the body as
    /// it was read. If the file no longer equals `base`, the two sets of
    /// changes are merged line by line instead of overwriting the other one,
    /// with conflict blocks where both changed the same lines. Waits for a
    /// running sync, so it never writes in the middle of one.
    ///
    /// Doesn't commit: call [`SyncEngine::commit_local`] shortly after.
    pub fn write_page_body(&self, id: &str, base: &str, body: &str) -> Result<PageWrite> {
        let _lock = self.lock()?;
        let workspace = Workspace::new(&self.root);
        if !workspace.page_exists(id) {
            return Ok(PageWrite::PageGone);
        }
        let on_disk = match workspace.read_body(id) {
            Ok(text) => text,
            Err(Error::Io { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e),
        };
        if on_disk == base || on_disk == body {
            if on_disk != body {
                workspace.write_body(id, body)?;
            }
            return Ok(PageWrite::Written);
        }
        let [base_oid, ours, theirs] =
            [base, body, on_disk.as_str()].map(|text| self.git.write_blob(&self.root, text.as_bytes()));
        let merge = self.git.merge_text(
            &self.root,
            &base_oid?,
            &ours?,
            &theirs?,
            [&self.config.device_name, "base", OTHER_CHANGES_LABEL],
            text_merge::MARKER_SIZE,
        )?;
        let merged =
            text_merge::rewrite_conflicts(&merge.content, &self.config.device_name, OTHER_CHANGES_LABEL);
        let merged = String::from_utf8(merged).map_err(|e| Error::InvalidData {
            path: format!("{}/{id}/{}", layout::PAGES_DIR, layout::PAGE_BODY),
            message: format!("merged page is not UTF-8: {e}"),
        })?;
        workspace.write_body(id, &merged)?;
        Ok(PageWrite::Merged {
            body: merged,
            conflicts: merge.conflicts,
        })
    }

    /// Resolve conflict block `index` on a page by keeping version `keep`
    /// (see [`crate::conflicts`]), and return the new body. Waits for a
    /// running sync. Doesn't commit.
    pub fn resolve_page_conflict(&self, id: &str, index: usize, keep: usize) -> Result<String> {
        let _lock = self.lock()?;
        let workspace = Workspace::new(&self.root);
        let body = conflicts::resolve_conflict(&workspace.read_body(id)?, index, keep)?;
        workspace.write_body(id, &body)?;
        Ok(body)
    }

    /// Commit local edits, merge in remote changes and publish the result.
    ///
    /// Never leaves the repository mid-merge: conflicts are resolved
    /// automatically and reported in [`SyncReport::conflicts`]. When the
    /// remote is unreachable this succeeds with [`SyncReport::offline`] set.
    pub fn sync(&self) -> Result<SyncReport> {
        let _lock = self.lock()?;
        let mut report = SyncReport {
            removed_locks: self.remove_stale_locks()?,
            ..SyncReport::default()
        };
        report.committed |= self.commit_locked("Save changes")?.is_some();

        for _ in 0..self.config.max_attempts {
            let local = self
                .head()?
                .ok_or_else(|| Error::InvalidState("the local branch has no commits".into()))?;
            let remote = match self
                .git
                .fetch(&self.root, &self.config.remote, &self.config.branch)
            {
                Ok(remote) => remote,
                Err(Error::Network(reason)) => {
                    report.offline = true;
                    report.offline_reason = Some(reason);
                    return Ok(report);
                }
                Err(e) => return Err(e),
            };

            let to_push = match remote {
                None => local,
                Some(remote) if remote == local => return Ok(report),
                Some(remote) if self.git.is_ancestor(&self.root, &remote, &local)? => local,
                Some(remote) if self.git.is_ancestor(&self.root, &local, &remote)? => {
                    match self.move_to(&local, &remote) {
                        Ok(()) => {
                            report.fast_forwarded = true;
                            return Ok(report);
                        }
                        Err(Error::WorkingTreeChanged(_)) => {
                            report.committed |= self.commit_locked("Save changes")?.is_some();
                            continue;
                        }
                        Err(e) => return Err(e),
                    }
                }
                Some(remote) => {
                    let outcome = merge::merge_commits(
                        self.git.as_ref(),
                        &self.root,
                        &local,
                        &remote,
                        &self.config.device_name,
                    )?;
                    let message = merge_message(&outcome.conflicts);
                    let commit = self.git.commit_tree(
                        &self.root,
                        &outcome.tree,
                        &[local.clone(), remote],
                        &message,
                        &self.signature(),
                    )?;
                    match self.move_to(&local, &commit) {
                        Ok(()) => {
                            report.merged = true;
                            report.conflicts.extend(outcome.conflicts);
                            commit
                        }
                        Err(Error::WorkingTreeChanged(_)) => {
                            report.committed |= self.commit_locked("Save changes")?.is_some();
                            continue;
                        }
                        Err(e) => return Err(e),
                    }
                }
            };

            match self
                .git
                .push(&self.root, &self.config.remote, &to_push, &self.config.branch)
            {
                Ok(PushResult::Pushed) => {
                    report.pushed = true;
                    return Ok(report);
                }
                Ok(PushResult::Rejected(_)) => continue,
                Err(Error::Network(reason)) => {
                    report.offline = true;
                    report.offline_reason = Some(reason);
                    return Ok(report);
                }
                Err(e) => return Err(e),
            }
        }
        Err(Error::PushRejected(self.config.max_attempts))
    }

    fn branch_ref(&self) -> String {
        format!("refs/heads/{}", self.config.branch)
    }

    fn signature(&self) -> Signature {
        let (name, email) = self.author();
        Signature {
            name,
            email,
            time: self.clock.now(),
        }
    }

    fn commit_locked(&self, message: &str) -> Result<Option<Oid>> {
        self.git.stage_all(&self.root)?;
        let tree = self.git.write_index_tree(&self.root)?;
        let head = self.head()?;
        if let Some(head) = &head
            && self
                .git
                .resolve(&self.root, &format!("{head}^{{tree}}"))?
                .as_ref()
                == Some(&tree)
        {
            return Ok(None);
        }
        let parents: Vec<Oid> = head.iter().cloned().collect();
        let commit = self
            .git
            .commit_tree(&self.root, &tree, &parents, message, &self.signature())?;
        self.git
            .update_ref(&self.root, &self.branch_ref(), &commit, head.as_ref())?;
        Ok(Some(commit))
    }

    /// Update the working tree first and the branch second. If we crash in
    /// between, the next commit simply records the new files as local edits
    /// on top of the old commit, which merges cleanly. The other order would
    /// make the next commit undo the remote's changes.
    fn move_to(&self, from: &Oid, to: &Oid) -> Result<()> {
        self.git.checkout(&self.root, from, to)?;
        self.git
            .update_ref(&self.root, &self.branch_ref(), to, Some(from))
    }

    fn write_initial_files(&self) -> Result<()> {
        let files: [(&str, Vec<u8>); 2] = [
            (".gitignore", layout::GITIGNORE.as_bytes().to_vec()),
            (
                layout::WORKSPACE_FILE,
                json_merge::to_canonical_bytes(&json!({ "format": 1 })),
            ),
        ];
        for (name, content) in files {
            let path = self.root.join(name);
            if !path.exists() {
                fs::write(&path, content).at(&path)?;
            }
        }
        Ok(())
    }

    fn git_dir(&self) -> PathBuf {
        self.root.join(".git")
    }

    fn lock(&self) -> Result<File> {
        let path = self.git_dir().join("docsync.lock");
        let file = File::options()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .at(&path)?;
        file.lock().at(&path)?;
        Ok(file)
    }

    /// Remove lock files and temporary indexes a crashed git process left
    /// behind. Only called while holding our own lock.
    fn remove_stale_locks(&self) -> Result<Vec<String>> {
        let git_dir = self.git_dir();
        let mut removed = Vec::new();
        let locks = [
            "index.lock".to_string(),
            "HEAD.lock".to_string(),
            format!("{}.lock", self.branch_ref()),
        ];
        for name in locks {
            let path = git_dir.join(&name);
            let Ok(meta) = fs::metadata(&path) else { continue };
            let age = meta
                .modified()
                .ok()
                .and_then(|m| SystemTime::now().duration_since(m).ok())
                .unwrap_or_default();
            if age >= self.config.stale_lock_age {
                fs::remove_file(&path).at(&path)?;
                removed.push(name);
            }
        }
        if let Ok(entries) = fs::read_dir(&git_dir) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with("docsync-index-") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        Ok(removed)
    }
}

fn merge_message(conflicts: &[ResolvedConflict]) -> String {
    let mut message = String::from("Merge changes from other devices\n");
    if !conflicts.is_empty() {
        message.push_str("\nAutomatically resolved:\n");
        for c in conflicts {
            message.push_str(&format!("- {}: {}\n", c.path, c.resolution));
        }
    }
    message
}
