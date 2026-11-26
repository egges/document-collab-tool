use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde_json::json;

use crate::error::IoContext;
use crate::git::{GitBackend, Oid, PushResult, Signature};
use crate::merge::{self, ResolvedConflict};
use crate::text_merge::{VersionLabel, Writer};
use crate::{Clock, Error, Result, Workspace, conflicts, json_merge, layout, text_merge};

/// Label for the on-disk side when [`SyncEngine::write_page_body`] merges.
pub const OTHER_CHANGES_LABEL: &str = "Changed elsewhere";

/// Where device refs live in a folder remote.
pub const DEVICE_REFS: &str = "refs/heads/devices/";

/// How devices share history through the remote.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum RemoteLayout {
    /// One branch that every device pushes to; git refuses a push that
    /// would lose another device's commits. For git hosts.
    #[default]
    SharedBranch,
    /// A bare repository in a cloud folder (Dropbox, iCloud Drive, ...),
    /// which copies files one by one, in any order and with delays. Each
    /// device writes only its own ref, `refs/heads/devices/<device_id>`,
    /// so no file has two writers, and merges everyone else's.
    DeviceRefs { device_id: String },
}

/// What a remote holds, compared with this workspace's history: see
/// [`SyncEngine::check_remote`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteCheck {
    /// It shares history with this workspace.
    SameWorkspace,
    /// No commits yet (for a folder remote: none that have fully arrived).
    Empty,
    /// Commits with no history in common: a different workspace.
    OtherWorkspace,
    /// It can't be reached right now, with git's reason.
    Unreachable(String),
}

/// The commit trailer that records who made a commit by their
/// [`Person::id`]: `Person-Id: 3f9a1c2b5e6d7f80`.
pub const PERSON_ID_TRAILER: &str = "Person-Id";

/// Who is using this device, as new commits record them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Person {
    /// Shown with their edits, e.g. in conflict blocks.
    pub name: String,
    /// The commit author's email.
    pub email: String,
    /// What tells them apart from others with the same name. Ours, not a
    /// Git host's: the app decides it (see the desktop app's `session.rs`).
    /// Recorded in every commit they make as a [`PERSON_ID_TRAILER`], and
    /// read back from there when a merge labels a conflict block.
    pub id: Option<String>,
}

/// Settings for one device's copy of a workspace.
#[derive(Debug, Clone)]
pub struct SyncConfig {
    pub remote: String,
    pub branch: String,
    pub layout: RemoteLayout,
    /// Shown in conflict blocks and conflict-copy names, e.g. "Arjan's
    /// MacBook", and recorded in every commit. The name to start with: see
    /// [`SyncEngine::set_device_name`].
    pub device_name: String,
    /// What tells this device apart from others with the same name, and
    /// stays when it's renamed: the desktop app's id for its install.
    /// Recorded in every commit and conflict block, so a version can be
    /// matched to the device it came from. Not the [`RemoteLayout`]'s
    /// device id, which is per copy of a workspace.
    pub device_id: Option<String>,
    /// How many fetch/merge/push rounds to try before giving up when other
    /// devices keep pushing in between.
    pub max_attempts: u32,
    /// Git lock files older than this are assumed to be left behind by a
    /// crashed process and are removed.
    pub stale_lock_age: Duration,
}

impl SyncConfig {
    pub fn new(device_name: impl Into<String>) -> Self {
        Self {
            remote: "origin".into(),
            branch: "main".into(),
            layout: RemoteLayout::SharedBranch,
            device_name: device_name.into(),
            device_id: None,
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
    /// Folder remotes only: devices whose latest changes haven't fully
    /// arrived in the folder yet. They're merged on a later sync.
    pub incomplete_devices: Vec<String>,
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
    /// Starts as the config's; see [`SyncEngine::set_device_name`].
    device_name: std::sync::Mutex<String>,
    /// Name and email of the person signed in on this device, if anyone;
    /// see [`SyncEngine::set_person`].
    person: std::sync::Mutex<Option<Person>>,
    /// Starts as the config's; see [`SyncEngine::set_remote_layout`].
    layout: std::sync::Mutex<RemoteLayout>,
}

impl SyncEngine {
    fn new(git: Arc<dyn GitBackend>, root: PathBuf, config: SyncConfig, clock: Arc<dyn Clock>) -> Self {
        let device_name = config.device_name.clone();
        let layout = config.layout.clone();
        Self {
            git,
            root,
            config,
            clock,
            device_name: std::sync::Mutex::new(device_name),
            person: std::sync::Mutex::new(None),
            layout: std::sync::Mutex::new(layout),
        }
    }

    /// Create an empty folder remote at `dir`, e.g. `~/Dropbox/Notes.docsync`,
    /// for workspaces with [`RemoteLayout::DeviceRefs`].
    pub fn create_folder_remote(git: &dyn GitBackend, dir: &Path) -> Result<()> {
        if dir.exists() && fs::read_dir(dir).at(dir)?.next().is_some() {
            return Err(Error::InvalidState(format!("{} isn't empty", dir.display())));
        }
        git.init_folder_remote(dir)
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
        // The id makes every workspace's first commit unique, even two
        // made on one device in the same second, so they're never taken
        // for the same workspace. In the message, so no file differs: two
        // devices starting one workspace on an empty remote still merge
        // without a conflict.
        engine.commit_local(&format!(
            "Create workspace\n\nWorkspace {}",
            crate::workspace::new_id()
        ))?;
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
        let start = match engine.remote_layout() {
            RemoteLayout::SharedBranch => {
                engine
                    .git
                    .fetch(&engine.root, &engine.config.remote, &engine.config.branch)?
            }
            RemoteLayout::DeviceRefs { .. } => {
                prepare_folder_remote(&engine.folder_path()?).map_err(Error::Network)?;
                let mut report = SyncReport::default();
                let tips = engine.fetch_device_refs(&mut report)?;
                if tips.is_empty() && !report.incomplete_devices.is_empty() {
                    return Err(Error::Network(
                        "the workspace hasn't finished downloading into this folder yet".into(),
                    ));
                }
                // The first sync merges the other devices' refs.
                tips.into_iter().next().map(|(_, oid)| oid)
            }
        };
        match start {
            Some(remote) => {
                let empty_tree = engine.git.write_index_tree(&engine.root)?;
                engine.git.checkout(&engine.root, &empty_tree, &remote)?;
                engine
                    .git
                    .update_ref(&engine.root, &engine.branch_ref(), &remote, None)?;
            }
            None => {
                engine.write_initial_files()?;
                // The id makes every workspace's first commit unique, even two
                // made on one device in the same second, so they're never taken
                // for the same workspace. In the message, so no file differs: two
                // devices starting one workspace on an empty remote still merge
                // without a conflict.
                engine.commit_local(&format!(
                    "Create workspace\n\nWorkspace {}",
                    crate::workspace::new_id()
                ))?;
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

    /// The settings the engine was opened with. The device's name may have
    /// changed since; see [`SyncEngine::device_name`].
    pub fn config(&self) -> &SyncConfig {
        &self.config
    }

    /// This device's name, as conflict blocks and new commits have it.
    pub fn device_name(&self) -> String {
        self.device_name.lock().unwrap().clone()
    }

    /// Rename this device. Earlier commits, and the conflict blocks already
    /// in pages, keep the name they were written with.
    pub fn set_device_name(&self, name: impl Into<String>) {
        *self.device_name.lock().unwrap() = name.into();
    }

    /// Who is using this device, or `None` when nobody is known. New
    /// commits are by that person, made on this device; without one they're
    /// by the device itself. Earlier commits keep their author.
    pub fn set_person(&self, person: Option<Person>) {
        *self.person.lock().unwrap() = person;
    }

    /// Who writes on this device now: what conflict blocks call this
    /// device's version.
    pub fn writer(&self) -> Writer {
        let person = self.person.lock().unwrap().clone();
        Writer {
            person_id: person.as_ref().and_then(|p| p.id.clone()),
            person: person.map(|p| p.name),
            device: Some(self.device_name()),
            device_id: self.config.device_id.clone(),
        }
    }

    pub fn set_remote(&self, url: &str) -> Result<()> {
        self.git.set_remote_url(&self.root, &self.config.remote, url)
    }

    /// Sync with `url` from now on, shared as `layout`, refusing a remote
    /// that already holds a different workspace: one whose history has
    /// nothing in common with this one's, which the next sync would mix in.
    /// An empty remote is fine, and so is one that can't be reached right
    /// now; a folder remote that isn't there is refused.
    ///
    /// Holds the sync lock, so no sync runs against `url` before it's
    /// checked. On failure the previous remote is kept.
    pub fn switch_remote(&self, url: &str, layout: RemoteLayout) -> Result<()> {
        match self.switch_if(url, layout, |check| *check != RemoteCheck::OtherWorkspace)? {
            RemoteCheck::OtherWorkspace => Err(Error::DifferentWorkspace(
                "That already holds a different workspace. Join that one instead, or choose an empty one."
                    .into(),
            )),
            _ => Ok(()),
        }
    }

    /// What `url` holds, shared as `layout`, without switching to it.
    pub fn check_remote(&self, url: &str, layout: RemoteLayout) -> Result<RemoteCheck> {
        self.switch_if(url, layout, |_| false)
    }

    /// Switch to `url` only if it already holds this workspace's history,
    /// e.g. to follow another device that moved the workspace there. An
    /// empty remote, or one that can't be reached yet, keeps the current
    /// one. Returns what `url` holds.
    pub fn follow_remote(&self, url: &str, layout: RemoteLayout) -> Result<RemoteCheck> {
        self.switch_if(url, layout, |check| *check == RemoteCheck::SameWorkspace)
    }

    /// Point the remote at `url`, check what it holds, and keep it there if
    /// `keep` says so; otherwise go back to the previous remote. Under the
    /// sync lock, so no sync runs against `url` meanwhile.
    fn switch_if(
        &self,
        url: &str,
        layout: RemoteLayout,
        keep: impl FnOnce(&RemoteCheck) -> bool,
    ) -> Result<RemoteCheck> {
        let _lock = self.lock()?;
        let old_url = self.git.remote_url(&self.root, &self.config.remote)?;
        let old_layout = self.remote_layout();
        self.git.set_remote_url(&self.root, &self.config.remote, url)?;
        self.set_remote_layout(layout);
        let check = self.check_current_remote();
        if let Ok(check) = &check
            && keep(check)
        {
            return Ok(check.clone());
        }
        if let Some(old) = old_url {
            self.git.set_remote_url(&self.root, &self.config.remote, &old)?;
        }
        self.set_remote_layout(old_layout);
        check
    }

    /// What the remote holds, compared with this workspace's history. A
    /// folder remote that isn't there is an [`Error::Network`].
    fn check_current_remote(&self) -> Result<RemoteCheck> {
        let Some(local) = self.head()? else {
            return Ok(RemoteCheck::Empty);
        };
        let tips = match self.remote_layout() {
            RemoteLayout::SharedBranch => {
                match self
                    .git
                    .fetch(&self.root, &self.config.remote, &self.config.branch)
                {
                    Ok(tip) => tip.into_iter().collect(),
                    Err(Error::Network(reason)) => return Ok(RemoteCheck::Unreachable(reason)),
                    Err(e) => return Err(e),
                }
            }
            RemoteLayout::DeviceRefs { .. } => {
                // Unlike a server that's down, a folder that isn't there is
                // an error: it's usually the wrong folder.
                prepare_folder_remote(&self.folder_path()?).map_err(Error::Network)?;
                match self.fetch_device_refs(&mut SyncReport::default()) {
                    Ok(tips) => tips.into_iter().map(|(_, oid)| oid).collect::<Vec<_>>(),
                    Err(Error::Network(reason)) => return Ok(RemoteCheck::Unreachable(reason)),
                    Err(e) => return Err(e),
                }
            }
        };
        for tip in &tips {
            if self.git.merge_base(&self.root, &local, tip)?.is_some() {
                return Ok(RemoteCheck::SameWorkspace);
            }
        }
        Ok(if tips.is_empty() {
            RemoteCheck::Empty
        } else {
            RemoteCheck::OtherWorkspace
        })
    }

    /// How history is shared through the remote, e.g. after switching from
    /// a git host to a cloud folder. Takes effect on the next sync.
    pub fn set_remote_layout(&self, layout: RemoteLayout) {
        *self.layout.lock().unwrap() = layout;
    }

    pub fn remote_layout(&self) -> RemoteLayout {
        self.layout.lock().unwrap().clone()
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
        // A database row is a page too, with its body next to its row file.
        if !workspace.has_body(id) {
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
            ["ours", "base", "theirs"],
            text_merge::MARKER_SIZE,
        )?;
        let merged = text_merge::rewrite_conflicts(
            &merge.content,
            &VersionLabel::By(self.writer()),
            &VersionLabel::Text(OTHER_CHANGES_LABEL.to_string()),
        );
        let merged = String::from_utf8(merged).map_err(|e| Error::InvalidData {
            path: format!("body of page {id}"),
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

    /// Move a page's front matter into its meta.json (see
    /// [`Workspace::lift_front_matter`]). Waits for a running sync. Returns
    /// whether the page changed; doesn't commit.
    pub fn lift_front_matter(&self, id: &str) -> Result<bool> {
        let _lock = self.lock()?;
        let workspace = Workspace::new(&self.root);
        if !workspace.page_exists(id) {
            return Ok(false);
        }
        workspace.lift_front_matter(id)
    }

    /// Import Markdown files and folders as pages under `parent` (see
    /// [`crate::import`]). Waits for a running sync, so a sync never
    /// publishes half an import. Doesn't commit.
    pub fn import_markdown(
        &self,
        sources: &[PathBuf],
        parent: Option<&str>,
    ) -> Result<crate::import::ImportReport> {
        let _lock = self.lock()?;
        crate::import::import_markdown(&Workspace::new(&self.root), sources, parent)
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
        if let RemoteLayout::DeviceRefs { device_id } = self.remote_layout() {
            return self.sync_device_refs(&device_id, report);
        }

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
                    let outcome =
                        merge::merge_commits(self.git.as_ref(), &self.root, &local, &remote, &self.writer())?;
                    let message = merge_message(&outcome.conflicts);
                    let commit = self.commit(&outcome.tree, &[local.clone(), remote], &message)?;
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

    /// [`SyncEngine::sync`] for a folder remote: fetch every device's ref
    /// that has fully arrived, merge them all into the local branch, and
    /// publish the result as this device's ref. Nobody else writes that
    /// ref, so publishing is never rejected.
    fn sync_device_refs(&self, device_id: &str, mut report: SyncReport) -> Result<SyncReport> {
        let own = format!("{DEVICE_REFS}{device_id}");
        for _ in 0..self.config.max_attempts {
            let local = self
                .head()?
                .ok_or_else(|| Error::InvalidState("the local branch has no commits".into()))?;
            report.incomplete_devices.clear();
            if let Err(reason) = prepare_folder_remote(&self.folder_path()?) {
                report.offline = true;
                report.offline_reason = Some(reason);
                return Ok(report);
            }
            let tips = match self.fetch_device_refs(&mut report) {
                Ok(tips) => tips,
                Err(Error::Network(reason)) => {
                    report.offline = true;
                    report.offline_reason = Some(reason);
                    return Ok(report);
                }
                Err(e) => return Err(e),
            };
            let published = tips
                .iter()
                .find(|(name, _)| *name == own)
                .map(|(_, oid)| oid.clone());

            let mut target = local.clone();
            let mut conflicts = Vec::new();
            let mut merged = false;
            for (_, tip) in &tips {
                if self.git.is_ancestor(&self.root, tip, &target)? {
                    continue;
                }
                if self.git.is_ancestor(&self.root, &target, tip)? {
                    target = tip.clone();
                    continue;
                }
                let outcome =
                    merge::merge_commits(self.git.as_ref(), &self.root, &target, tip, &self.writer())?;
                target = self.commit(
                    &outcome.tree,
                    &[target.clone(), tip.clone()],
                    &merge_message(&outcome.conflicts),
                )?;
                conflicts.extend(outcome.conflicts);
                merged = true;
            }
            if target != local {
                match self.move_to(&local, &target) {
                    Ok(()) if merged => {
                        report.merged = true;
                        report.conflicts.extend(conflicts);
                    }
                    Ok(()) => report.fast_forwarded = true,
                    Err(Error::WorkingTreeChanged(_)) => {
                        report.committed |= self.commit_locked("Save changes")?.is_some();
                        continue;
                    }
                    Err(e) => return Err(e),
                }
            }
            if published.as_ref() == Some(&target) {
                return Ok(report);
            }
            let folder = self.folder_path()?;
            return match self
                .git
                .publish_to_folder(&self.root, &folder, &target, published.as_ref(), &own)
            {
                Ok(()) => {
                    report.pushed = true;
                    Ok(report)
                }
                Err(Error::Network(reason)) => {
                    report.offline = true;
                    report.offline_reason = Some(reason);
                    Ok(report)
                }
                Err(e) => Err(e),
            };
        }
        Err(Error::PushRejected(self.config.max_attempts))
    }

    /// Every device ref in the folder remote whose objects have all
    /// arrived, fetched, by name. The others go in
    /// [`SyncReport::incomplete_devices`].
    fn fetch_device_refs(&self, report: &mut SyncReport) -> Result<Vec<(String, Oid)>> {
        let refs = self
            .git
            .remote_refs(&self.root, &self.config.remote, DEVICE_REFS)?;
        let mut tips = Vec::new();
        for (name, oid) in refs {
            let device = name.trim_start_matches(DEVICE_REFS).to_string();
            if self
                .git
                .resolve(&self.root, &format!("{oid}^{{commit}}"))?
                .is_some()
            {
                tips.push((name, oid));
                continue;
            }
            let branch = name.trim_start_matches("refs/heads/");
            match self.git.fetch(&self.root, &self.config.remote, branch) {
                Ok(Some(fetched)) => tips.push((name, fetched)),
                // Its ref arrived before its objects, or it vanished.
                Ok(None) | Err(Error::Network(_)) => report.incomplete_devices.push(device),
                Err(e) => return Err(e),
            }
        }
        Ok(tips)
    }

    /// The folder a folder remote's URL points to.
    pub fn folder_path(&self) -> Result<PathBuf> {
        let url = self
            .git
            .remote_url(&self.root, &self.config.remote)?
            .ok_or_else(|| Error::Network("no remote is set".into()))?;
        Ok(PathBuf::from(url.strip_prefix("file://").unwrap_or(&url)))
    }

    fn branch_ref(&self) -> String {
        format!("refs/heads/{}", self.config.branch)
    }

    /// Who new commits are by: the person signed in, or else this device.
    fn author(&self) -> Signature {
        match self.person.lock().unwrap().clone() {
            Some(person) => Signature {
                name: person.name,
                email: person.email,
                time: self.clock.now(),
            },
            None => self.committer(),
        }
    }

    /// Write a commit by [`SyncEngine::author`] on this device, with the
    /// person's id as a trailer when there is one.
    fn commit(&self, tree: &Oid, parents: &[Oid], message: &str) -> Result<Oid> {
        let id = self.person.lock().unwrap().as_ref().and_then(|p| p.id.clone());
        let message = match id {
            Some(id) => format!("{}\n\n{PERSON_ID_TRAILER}: {id}\n", message.trim_end()),
            None => message.to_string(),
        };
        self.git.commit_tree(
            &self.root,
            tree,
            parents,
            &message,
            &self.author(),
            &self.committer(),
        )
    }

    /// The device new commits are made on. Recorded as the committer, so a
    /// later merge can say whose version is whose by person and by device
    /// (see `merge::commit_writer`).
    fn committer(&self) -> Signature {
        let name = self.device_name();
        Signature {
            email: layout::device_email(&name, self.config.device_id.as_deref()),
            name,
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
        let commit = self.commit(&tree, &parents, message)?;
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

/// Check a folder remote before syncing with it: say why it can't be used
/// (moved, deleted, a drive that isn't connected, not downloaded yet), and
/// put back the empty folders git needs. Some sync services don't sync
/// empty folders, and git won't open a repository without them.
pub fn prepare_folder_remote(dir: &Path) -> std::result::Result<(), String> {
    if !dir.is_dir() {
        return Err(format!(
            "the folder {} isn't there: it was moved or deleted, or it's on a drive that isn't connected",
            dir.display()
        ));
    }
    if !dir.join("HEAD").is_file() {
        return Err(format!(
            "{} isn't a workspace's sync folder, or it hasn't finished downloading",
            dir.display()
        ));
    }
    for sub in ["objects/pack", "objects/info", "refs/heads", "refs/tags"] {
        // A read-only folder can still be read; git says so if it can't.
        let _ = fs::create_dir_all(dir.join(sub));
    }
    Ok(())
}
