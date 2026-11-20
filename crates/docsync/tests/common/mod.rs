//! Test harness: a shared bare "remote" repository plus any number of
//! simulated devices, each with a fault-injecting git backend.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use docsync::git::{
    CommitInfo, GitBackend, MergeTreeResult, Oid, PushResult, Signature, TextMerge, TreeEdit, TreeEntry,
};
use docsync::text_merge::has_git_conflict_markers;
use docsync::{CliGit, Error, ManualClock, Result, SyncConfig, SyncEngine, SyncReport, Workspace};
use tempfile::TempDir;

/// A raw `git` command (same binary as [`real_git`]) for test setup and
/// inspection, with the user's own git configuration ignored.
pub fn git_command() -> Command {
    let null_device = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let mut cmd = Command::new(real_git().binary());
    cmd.env("GIT_CONFIG_GLOBAL", null_device)
        .env("GIT_CONFIG_NOSYSTEM", "1");
    cmd
}

pub fn real_git() -> CliGit {
    let git = match std::env::var_os("DOCSYNC_TEST_GIT") {
        Some(path) => CliGit::new(path),
        None => CliGit::from_path(),
    };
    git.check_version().expect("a recent enough git binary");
    git
}

// ---- fault injection ---------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Init,
    SetRemote,
    HeadRef,
    Resolve,
    StageAll,
    WriteIndexTree,
    CommitTree,
    UpdateRef,
    Checkout,
    Fetch,
    Push,
    IsAncestor,
    MergeBase,
    MergeTrees,
    MergeText,
    ReadBlob,
    WriteBlob,
    ListTree,
    ChangedPaths,
    EditTree,
    PathHistory,
}

/// When an armed fault fires relative to the operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Crash {
    /// The process "dies" just before the operation runs.
    Before,
    /// The operation completes, then the process "dies".
    After,
}

type Hook = Box<dyn FnOnce() + Send>;

#[derive(Default)]
pub struct Faults {
    offline: AtomicBool,
    calls: AtomicUsize,
    armed: Mutex<Option<(usize, Crash)>>,
    fired: AtomicBool,
    hooks: Mutex<Vec<(Op, Hook)>>,
}

impl Faults {
    pub fn set_offline(&self, offline: bool) {
        self.offline.store(offline, Ordering::SeqCst);
    }

    /// Make the `nth` git call from now on fail (0-based).
    pub fn crash_at(&self, nth: usize, when: Crash) {
        self.calls.store(0, Ordering::SeqCst);
        self.fired.store(false, Ordering::SeqCst);
        *self.armed.lock().unwrap() = Some((nth, when));
    }

    pub fn disarm(&self) -> bool {
        *self.armed.lock().unwrap() = None;
        self.fired.load(Ordering::SeqCst)
    }

    /// Run `hook` once, right before the next `op`.
    pub fn before_next(&self, op: Op, hook: impl FnOnce() + Send + 'static) {
        self.hooks.lock().unwrap().push((op, Box::new(hook)));
    }

    fn before(&self, op: Op) -> Result<usize> {
        let hook = {
            let mut hooks = self.hooks.lock().unwrap();
            hooks
                .iter()
                .position(|(o, _)| *o == op)
                .map(|i| hooks.remove(i).1)
        };
        if let Some(hook) = hook {
            hook();
        }
        if matches!(op, Op::Fetch | Op::Push) && self.offline.load(Ordering::SeqCst) {
            return Err(Error::Network("simulated: offline".into()));
        }
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        if *self.armed.lock().unwrap() == Some((n, Crash::Before)) {
            self.fired.store(true, Ordering::SeqCst);
            return Err(Error::Other(format!("simulated crash before {op:?}")));
        }
        Ok(n)
    }

    fn after<T>(&self, n: usize, op: Op, result: Result<T>) -> Result<T> {
        if *self.armed.lock().unwrap() == Some((n, Crash::After)) {
            self.fired.store(true, Ordering::SeqCst);
            return Err(Error::Other(format!("simulated crash after {op:?}")));
        }
        result
    }
}

pub struct FaultyGit {
    inner: CliGit,
    faults: Arc<Faults>,
}

macro_rules! wrap {
    ($self:ident, $op:expr, $call:expr) => {{
        let n = $self.faults.before($op)?;
        let result = $call;
        $self.faults.after(n, $op, result)
    }};
}

impl GitBackend for FaultyGit {
    fn version(&self) -> Result<String> {
        self.inner.version()
    }
    fn init(&self, dir: &Path, branch: &str) -> Result<()> {
        wrap!(self, Op::Init, self.inner.init(dir, branch))
    }
    fn set_remote_url(&self, repo: &Path, remote: &str, url: &str) -> Result<()> {
        wrap!(self, Op::SetRemote, self.inner.set_remote_url(repo, remote, url))
    }
    fn head_ref(&self, repo: &Path) -> Result<Option<String>> {
        wrap!(self, Op::HeadRef, self.inner.head_ref(repo))
    }
    fn resolve(&self, repo: &Path, rev: &str) -> Result<Option<Oid>> {
        wrap!(self, Op::Resolve, self.inner.resolve(repo, rev))
    }
    fn stage_all(&self, repo: &Path) -> Result<()> {
        wrap!(self, Op::StageAll, self.inner.stage_all(repo))
    }
    fn write_index_tree(&self, repo: &Path) -> Result<Oid> {
        wrap!(self, Op::WriteIndexTree, self.inner.write_index_tree(repo))
    }
    fn commit_tree(
        &self,
        repo: &Path,
        tree: &Oid,
        parents: &[Oid],
        message: &str,
        author: &Signature,
    ) -> Result<Oid> {
        wrap!(
            self,
            Op::CommitTree,
            self.inner.commit_tree(repo, tree, parents, message, author)
        )
    }
    fn update_ref(&self, repo: &Path, refname: &str, new: &Oid, expected_old: Option<&Oid>) -> Result<()> {
        wrap!(
            self,
            Op::UpdateRef,
            self.inner.update_ref(repo, refname, new, expected_old)
        )
    }
    fn checkout(&self, repo: &Path, from: &Oid, to: &Oid) -> Result<()> {
        wrap!(self, Op::Checkout, self.inner.checkout(repo, from, to))
    }
    fn fetch(&self, repo: &Path, remote: &str, branch: &str) -> Result<Option<Oid>> {
        wrap!(self, Op::Fetch, self.inner.fetch(repo, remote, branch))
    }
    fn push(&self, repo: &Path, remote: &str, commit: &Oid, branch: &str) -> Result<PushResult> {
        wrap!(self, Op::Push, self.inner.push(repo, remote, commit, branch))
    }
    fn is_ancestor(&self, repo: &Path, ancestor: &Oid, descendant: &Oid) -> Result<bool> {
        wrap!(
            self,
            Op::IsAncestor,
            self.inner.is_ancestor(repo, ancestor, descendant)
        )
    }
    fn merge_base(&self, repo: &Path, a: &Oid, b: &Oid) -> Result<Option<Oid>> {
        wrap!(self, Op::MergeBase, self.inner.merge_base(repo, a, b))
    }
    fn merge_trees(&self, repo: &Path, ours: &Oid, theirs: &Oid) -> Result<MergeTreeResult> {
        wrap!(self, Op::MergeTrees, self.inner.merge_trees(repo, ours, theirs))
    }
    fn merge_text(
        &self,
        repo: &Path,
        base: &Oid,
        ours: &Oid,
        theirs: &Oid,
        labels: [&str; 3],
        marker_size: usize,
    ) -> Result<TextMerge> {
        wrap!(
            self,
            Op::MergeText,
            self.inner
                .merge_text(repo, base, ours, theirs, labels, marker_size)
        )
    }
    fn read_blob(&self, repo: &Path, oid: &Oid) -> Result<Vec<u8>> {
        wrap!(self, Op::ReadBlob, self.inner.read_blob(repo, oid))
    }
    fn write_blob(&self, repo: &Path, data: &[u8]) -> Result<Oid> {
        wrap!(self, Op::WriteBlob, self.inner.write_blob(repo, data))
    }
    fn list_tree(&self, repo: &Path, treeish: &Oid, prefix: Option<&str>) -> Result<Vec<TreeEntry>> {
        wrap!(self, Op::ListTree, self.inner.list_tree(repo, treeish, prefix))
    }
    fn changed_paths(&self, repo: &Path, from: &Oid, to: &Oid) -> Result<Vec<String>> {
        wrap!(self, Op::ChangedPaths, self.inner.changed_paths(repo, from, to))
    }
    fn edit_tree(&self, repo: &Path, base: &Oid, edits: &[TreeEdit]) -> Result<Oid> {
        wrap!(self, Op::EditTree, self.inner.edit_tree(repo, base, edits))
    }
    fn path_history(
        &self,
        repo: &Path,
        since: Option<&Oid>,
        until: &Oid,
        path: &str,
    ) -> Result<Vec<CommitInfo>> {
        wrap!(
            self,
            Op::PathHistory,
            self.inner.path_history(repo, since, until, path)
        )
    }
}

// ---- simulated devices ---------------------------------------------------

pub struct Device {
    pub name: String,
    pub engine: SyncEngine,
    pub ws: Workspace,
    pub faults: Arc<Faults>,
}

impl Device {
    pub fn root(&self) -> &Path {
        self.engine.root()
    }

    pub fn sync(&self) -> SyncReport {
        self.engine
            .sync()
            .unwrap_or_else(|e| panic!("sync on {} failed: {e}", self.name))
    }

    pub fn commit(&self) {
        self.engine.commit_local("edit").expect("commit");
    }

    pub fn head(&self) -> Oid {
        self.engine.head().unwrap().expect("has commits")
    }

    /// Every synced file in the workspace, by relative path.
    pub fn files(&self) -> BTreeMap<String, Vec<u8>> {
        let mut files = BTreeMap::new();
        collect_files(self.root(), self.root(), &mut files);
        files
    }

    pub fn file(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(self.root().join(path)).ok()
    }
}

fn collect_files(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if rel == ".git" {
            continue;
        }
        if path.is_dir() {
            collect_files(root, &path, out);
        } else {
            out.insert(rel, std::fs::read(&path).unwrap());
        }
    }
}

pub struct Net {
    dir: TempDir,
    pub remote: PathBuf,
    pub clock: Arc<ManualClock>,
}

impl Net {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let remote = dir.path().join("remote.git");
        let status = git_command()
            .args(["init", "-q", "--bare", "-b", "main"])
            .arg(&remote)
            .status()
            .unwrap();
        assert!(status.success());
        Net {
            dir,
            remote,
            clock: Arc::new(ManualClock::new(1_700_000_000)),
        }
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    pub fn url(&self) -> String {
        self.remote.to_string_lossy().into_owned()
    }

    /// A new device that joins the workspace and syncs once.
    pub fn device(&self, name: &str) -> Device {
        let device = self.device_unsynced(name);
        device.sync();
        device
    }

    /// A new device that joins the workspace but has not synced yet.
    pub fn device_unsynced(&self, name: &str) -> Device {
        let faults = Arc::new(Faults::default());
        let git = Arc::new(FaultyGit {
            inner: real_git(),
            faults: faults.clone(),
        });
        let mut config = SyncConfig::new(name);
        config.stale_lock_age = std::time::Duration::ZERO;
        let root = self.dir.path().join(name);
        let engine =
            SyncEngine::clone_remote(git, &self.url(), &root, config, self.clock.clone()).expect("clone");
        Device {
            name: name.to_string(),
            ws: Workspace::new(&root),
            engine,
            faults,
        }
    }

    /// Reopen an existing device directory (as after an app restart).
    pub fn reopen(&self, device: Device) -> Device {
        let Device {
            name,
            ws,
            faults,
            engine,
        } = device;
        let root = engine.root().to_path_buf();
        drop(engine);
        let git = Arc::new(FaultyGit {
            inner: real_git(),
            faults: faults.clone(),
        });
        let mut config = SyncConfig::new(&name);
        config.stale_lock_age = std::time::Duration::ZERO;
        let engine = SyncEngine::open(git, root, config, self.clock.clone()).expect("open");
        Device {
            name,
            ws,
            engine,
            faults,
        }
    }
}

// ---- invariants ----------------------------------------------------------

/// Sync every device until nothing changes, then check that they all hold
/// exactly the same files and commit.
pub fn settle(devices: &[&Device]) {
    for _ in 0..3 {
        for d in devices {
            d.sync();
        }
    }
    assert_converged(devices);
}

pub fn assert_converged(devices: &[&Device]) {
    let first = devices[0];
    for d in &devices[1..] {
        assert_eq!(
            d.head(),
            first.head(),
            "{} and {} are on different commits",
            d.name,
            first.name
        );
        let (a, b) = (first.files(), d.files());
        let keys_a: Vec<_> = a.keys().collect();
        let keys_b: Vec<_> = b.keys().collect();
        assert_eq!(
            keys_a, keys_b,
            "{} and {} have different files",
            first.name, d.name
        );
        for (path, content) in &a {
            assert_eq!(
                String::from_utf8_lossy(content),
                String::from_utf8_lossy(&b[path]),
                "{path} differs between {} and {}",
                first.name,
                d.name
            );
        }
    }
    for d in devices {
        assert_valid(d);
    }
}

/// Structural invariants that must hold for every device at all times.
pub fn assert_valid(device: &Device) {
    for (path, content) in device.files() {
        let text = String::from_utf8_lossy(&content);
        assert!(
            !has_git_conflict_markers(&text),
            "{}: raw conflict markers in {path}:\n{text}",
            device.name
        );
        assert!(
            !path.ends_with(docsync::layout::TEMP_SUFFIX),
            "{}: temp file {path} left behind",
            device.name
        );
        // Conflict copies hold whatever the user wrote, valid or not.
        if path.ends_with(".json") && !path.contains(docsync::layout::CONFLICT_COPY_MARKER) {
            serde_json::from_slice::<serde_json::Value>(&content)
                .unwrap_or_else(|e| panic!("{}: {path} is not valid JSON ({e}):\n{text}", device.name));
        }
    }
    for page in device.ws.list_pages().unwrap() {
        let dir = device.root().join("pages").join(&page);
        assert!(
            dir.join("meta.json").is_file(),
            "{}: page {page} has no meta.json",
            device.name
        );
        assert!(
            dir.join("page.md").is_file(),
            "{}: page {page} has no page.md",
            device.name
        );
    }
    for db in device.ws.list_databases().unwrap() {
        assert!(
            device.ws.database_exists(&db),
            "{}: database {db} has rows but no schema",
            device.name
        );
    }
    let git_dir = device.root().join(".git");
    for leftover in ["MERGE_HEAD", "index.lock", "rebase-merge", "rebase-apply"] {
        assert!(
            !git_dir.join(leftover).exists(),
            "{}: .git/{leftover} left behind",
            device.name
        );
    }
}
