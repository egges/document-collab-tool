//! When to commit and sync (roadmap step 2, "When to sync").
//!
//! One background thread per open workspace:
//! - **Commit** a couple of seconds after the last edit, so commit times
//!   (which decide which edit wins a clash on a JSON field) are close to
//!   when the edit was made, without a commit per keystroke.
//! - **Sync** when the workspace opens, every 45 seconds, when the window
//!   gains focus (at most every 10 seconds), and when asked to.
//! - **Notice files changed outside the app** (an AI agent, a text editor,
//!   a sync from another process): tell the UI to reload, and commit them.
//!
//! The UI never waits for git: it talks to the worker through a channel and
//! hears back through [`Events`].

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use docsync::SyncEngine;

use crate::devlog;
use serde::Serialize;

#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub commit_delay: Duration,
    pub sync_interval: Duration,
    pub focus_min_gap: Duration,
    /// How long to collect file-change notifications before reporting them.
    pub change_delay: Duration,
    /// How long to wait for more files after something arrives in a folder
    /// remote, before syncing.
    pub remote_delay: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            commit_delay: Duration::from_secs(2),
            sync_interval: Duration::from_secs(45),
            focus_min_gap: Duration::from_secs(10),
            change_delay: Duration::from_millis(300),
            remote_delay: Duration::from_secs(2),
        }
    }
}

/// What the UI shows at the bottom of the sidebar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub state: SyncState,
    /// Why it's offline or failed.
    pub message: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub last_synced: Option<u64>,
    /// Conflicts the last sync resolved by keeping both versions.
    pub conflicts: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncState {
    /// No remote: edits are committed but go nowhere.
    LocalOnly,
    Syncing,
    Synced,
    Offline,
    /// The remote refused this device: not signed in, or an account
    /// without access. Unlike being offline, it won't pass by itself.
    NoAccess,
    Error,
}

/// How the worker reports back. The app sends these to the window as Tauri
/// events; tests record them.
pub trait Events: Send + 'static {
    fn status(&self, status: &SyncStatus);
    /// Files in the workspace changed (a sync pulled changes in, or another
    /// program edited them). The UI rereads what it shows.
    fn workspace_changed(&self);
}

enum Msg {
    Edited,
    FilesChanged,
    RemoteChanged,
    SyncNow,
    Focused,
    Stop,
}

/// Handle to the worker thread. Dropping it commits pending edits and stops
/// the thread.
pub struct SyncWorker {
    tx: Sender<Msg>,
    has_remote: Arc<AtomicBool>,
    last_status: Arc<Mutex<Option<SyncStatus>>>,
    thread: Option<JoinHandle<()>>,
}

impl SyncWorker {
    pub fn start(engine: Arc<SyncEngine>, has_remote: bool, events: impl Events, timing: Timing) -> Self {
        let (tx, rx) = mpsc::channel();
        let has_remote = Arc::new(AtomicBool::new(has_remote));
        let flag = has_remote.clone();
        let last_status = Arc::new(Mutex::new(None));
        let events = Remembering {
            inner: events,
            last: last_status.clone(),
        };
        let thread = std::thread::Builder::new()
            .name("sync".into())
            .spawn(move || Loop::new(engine, flag, events, timing).run(rx))
            .expect("spawn sync thread");
        Self {
            tx,
            has_remote,
            last_status,
            thread: Some(thread),
        }
    }

    /// A callback telling the worker the app changed something, so it
    /// commits soon. Usable from any thread.
    pub fn edit_notifier(&self) -> impl Fn() + Send + 'static + use<> {
        let tx = self.tx.clone();
        move || {
            let _ = tx.send(Msg::Edited);
        }
    }

    pub fn sync_now(&self) {
        let _ = self.tx.send(Msg::SyncNow);
    }

    pub fn focused(&self) {
        let _ = self.tx.send(Msg::Focused);
    }

    /// The most recent status, for a window that subscribed to status events
    /// after the first sync already reported.
    pub fn last_status(&self) -> Option<SyncStatus> {
        self.last_status.lock().unwrap().clone()
    }

    pub fn set_has_remote(&self, has_remote: bool) {
        self.has_remote.store(has_remote, Ordering::SeqCst);
        self.sync_now();
    }

    /// A callback for a folder remote's watcher: syncs shortly after files
    /// arrive, once they stop arriving.
    pub fn remote_change_notifier(&self) -> impl Fn() + Send + 'static + use<> {
        let tx = self.tx.clone();
        move || {
            let _ = tx.send(Msg::RemoteChanged);
        }
    }

    /// A callback for a file watcher: reports changes outside `.git` and
    /// `.docsync`.
    pub fn file_change_notifier(&self) -> impl Fn(&[&Path]) + Send + 'static + use<> {
        let tx = self.tx.clone();
        move |paths| {
            let relevant: Vec<String> = paths
                .iter()
                .filter(|p| is_workspace_file(p))
                .map(|p| short_path(p))
                .collect();
            if !relevant.is_empty() {
                devlog::debug("watch", format!("Changed on disk: {}", relevant.join(", ")));
                let _ = tx.send(Msg::FilesChanged);
            }
        }
    }
}

impl Drop for SyncWorker {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Passes events on and remembers the last status.
struct Remembering<E> {
    inner: E,
    last: Arc<Mutex<Option<SyncStatus>>>,
}

impl<E: Events> Events for Remembering<E> {
    fn status(&self, status: &SyncStatus) {
        *self.last.lock().unwrap() = Some(status.clone());
        self.inner.status(status);
    }
    fn workspace_changed(&self) {
        self.inner.workspace_changed();
    }
}

/// The last three parts of a path, e.g. "pages/abc123/page.md".
fn short_path(path: &Path) -> String {
    let parts: Vec<_> = path.iter().map(|p| p.to_string_lossy()).collect();
    parts[parts.len().saturating_sub(3)..].join("/")
}

/// Whether a changed path is workspace content rather than git's or our own
/// bookkeeping.
fn is_workspace_file(path: &Path) -> bool {
    let ignored = path
        .components()
        .any(|c| matches!(c.as_os_str().to_str(), Some(".git" | ".docsync")));
    let temp = path
        .to_str()
        .is_some_and(|p| p.ends_with(docsync::layout::TEMP_SUFFIX));
    !ignored && !temp
}

struct Loop<E> {
    engine: Arc<SyncEngine>,
    has_remote: Arc<AtomicBool>,
    events: E,
    timing: Timing,
    commit_at: Option<Instant>,
    changed_at: Option<Instant>,
    sync_at: Instant,
    /// Why the next sync happens, for the developer log.
    sync_reason: &'static str,
    last_sync: Option<Instant>,
    last_synced: Option<u64>,
    /// When the last sync finished; changes a folder remote reports right
    /// after are usually the sync's own.
    sync_ended: Option<Instant>,
}

impl<E: Events> Loop<E> {
    fn new(engine: Arc<SyncEngine>, has_remote: Arc<AtomicBool>, events: E, timing: Timing) -> Self {
        Self {
            engine,
            has_remote,
            events,
            timing,
            commit_at: None,
            changed_at: None,
            sync_at: Instant::now(),
            sync_reason: "workspace opened",
            last_sync: None,
            last_synced: None,
            sync_ended: None,
        }
    }

    fn run(mut self, rx: mpsc::Receiver<Msg>) {
        loop {
            let next = [self.commit_at, self.changed_at, Some(self.sync_at)]
                .into_iter()
                .flatten()
                .min()
                .expect("sync_at is always set");
            let now = Instant::now();
            match rx.recv_timeout(next.saturating_duration_since(now)) {
                Ok(Msg::Edited) => self.commit_at = Some(now + self.timing.commit_delay),
                Ok(Msg::FilesChanged) => {
                    self.changed_at.get_or_insert(now + self.timing.change_delay);
                    self.commit_at = Some(now + self.timing.commit_delay);
                }
                Ok(Msg::SyncNow) => {
                    self.sync_at = now;
                    self.sync_reason = "requested";
                }
                Ok(Msg::RemoteChanged) => {
                    let own = self
                        .sync_ended
                        .is_some_and(|t| now - t < self.timing.remote_delay);
                    let at = now + self.timing.remote_delay;
                    if !own && at < self.sync_at {
                        self.sync_at = at;
                        self.sync_reason = "changes arrived in the shared folder";
                    }
                }
                Ok(Msg::Focused) => {
                    if self
                        .last_sync
                        .is_none_or(|t| now - t >= self.timing.focus_min_gap)
                    {
                        self.sync_at = now;
                        self.sync_reason = "window focused";
                    } else {
                        devlog::debug("sync", "Window focused; synced recently, so not syncing again");
                    }
                }
                Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => {}
            }

            let now = Instant::now();
            if self.changed_at.is_some_and(|t| t <= now) {
                self.changed_at = None;
                devlog::debug("watch", "Files changed: telling the window to reload");
                self.events.workspace_changed();
            }
            if self.sync_at <= now {
                self.sync();
            } else if self.commit_at.is_some_and(|t| t <= now) {
                self.commit();
            }
        }
        // Don't lose a commit time on quit; the edits themselves are on disk.
        if self.commit_at.is_some() {
            self.commit();
        }
        devlog::info("sync", "Stopped the sync worker");
    }

    fn commit(&mut self) {
        self.commit_at = None;
        match self.engine.commit_local("Edit pages") {
            Ok(Some(commit)) => devlog::info("sync", format!("Committed edits ({})", commit.short())),
            Ok(None) => devlog::debug("sync", "Nothing to commit"),
            Err(e) => {
                devlog::error("sync", format!("Commit failed: {e}"));
                self.report(SyncState::Error, Some(e.to_string()), 0);
            }
        }
    }

    fn sync(&mut self) {
        let reason = std::mem::replace(&mut self.sync_reason, "interval");
        self.sync_at = Instant::now() + self.timing.sync_interval;
        self.last_sync = Some(Instant::now());
        if !self.has_remote.load(Ordering::SeqCst) {
            devlog::debug("sync", format!("Sync skipped ({reason}): no remote set"));
            self.commit();
            self.report(SyncState::LocalOnly, None, 0);
            return;
        }
        self.commit_at = None; // sync commits first
        self.report(SyncState::Syncing, None, 0);
        devlog::info("sync", format!("Sync started ({reason})"));
        let started = Instant::now();
        let result = self.engine.sync();
        let ms = started.elapsed().as_millis();
        match result {
            Ok(report) if report.offline => {
                devlog::warn(
                    "sync",
                    format!(
                        "Offline after {ms} ms{}: {}",
                        if report.committed {
                            " (edits committed locally)"
                        } else {
                            ""
                        },
                        devlog::short(report.offline_reason.as_deref().unwrap_or("?"), 400)
                    ),
                );
                let state = offline_state(report.offline_reason.as_deref().unwrap_or_default());
                let reason = report.offline_reason.as_deref().map(first_line);
                self.report(state, reason, 0);
            }
            Ok(report) => {
                devlog::info("sync", format!("Sync done in {ms} ms: {}", describe(&report)));
                if !report.incomplete_devices.is_empty() {
                    devlog::info(
                        "sync",
                        format!(
                            "Still arriving in the shared folder, merged later: {}",
                            report.incomplete_devices.join(", ")
                        ),
                    );
                }
                for conflict in &report.conflicts {
                    devlog::warn(
                        "sync",
                        format!("Resolved a conflict: {}: {}", conflict.path, conflict.resolution),
                    );
                }
                self.last_synced = Some(now_ms());
                self.report(SyncState::Synced, None, report.conflicts.len());
                if report.fast_forwarded || report.merged {
                    // The file watcher would notice too, but not on every
                    // platform as quickly, and not in tests.
                    self.events.workspace_changed();
                }
            }
            Err(e) => {
                devlog::error("sync", format!("Sync failed after {ms} ms: {e}"));
                self.report(SyncState::Error, Some(e.to_string()), 0);
            }
        }
        self.sync_ended = Some(Instant::now());
    }

    fn report(&self, state: SyncState, message: Option<String>, conflicts: usize) {
        self.events.status(&SyncStatus {
            state,
            message,
            last_synced: self.last_synced,
            conflicts,
        });
    }
}

/// What a sync did, e.g. "committed, merged, pushed".
fn describe(report: &docsync::SyncReport) -> String {
    let mut parts = Vec::new();
    for (done, what) in [
        (report.committed, "committed local edits"),
        (report.fast_forwarded, "pulled changes"),
        (report.merged, "merged changes"),
        (report.pushed, "pushed"),
    ] {
        if done {
            parts.push(what.to_string());
        }
    }
    if !report.conflicts.is_empty() {
        parts.push(format!("{} conflicts resolved", report.conflicts.len()));
    }
    if !report.removed_locks.is_empty() {
        parts.push(format!(
            "removed stale locks: {}",
            report.removed_locks.join(", ")
        ));
    }
    if parts.is_empty() {
        "already up to date".into()
    } else {
        parts.join(", ")
    }
}

/// Offline, or refused by the remote, from what git said.
fn offline_state(reason: &str) -> SyncState {
    // A token about to be renewed may already be refused; that passes once
    // it's renewed, so it's not worth a warning.
    if docsync::git::is_access_denied(reason) && !crate::github::renewal_due() {
        SyncState::NoAccess
    } else {
        SyncState::Offline
    }
}

fn first_line(text: &str) -> String {
    text.lines()
        .map(|l| l.trim().trim_start_matches("fatal: "))
        .find(|l| !l.is_empty())
        .unwrap_or("The remote can't be reached")
        .to_string()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use docsync::{CliGit, SyncConfig, SystemClock, Workspace};

    use super::*;

    #[derive(Clone, Default)]
    struct Recorder(Arc<Mutex<Vec<String>>>);

    impl Events for Recorder {
        fn status(&self, status: &SyncStatus) {
            self.0.lock().unwrap().push(format!("{:?}", status.state));
        }
        fn workspace_changed(&self) {
            self.0.lock().unwrap().push("changed".into());
        }
    }

    impl Recorder {
        fn wait_for(&self, entry: &str) {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !self.0.lock().unwrap().iter().any(|e| e == entry) {
                assert!(
                    Instant::now() < deadline,
                    "no {entry:?} in {:?}",
                    self.0.lock().unwrap()
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        fn clear(&self) {
            self.0.lock().unwrap().clear();
        }
    }

    fn fast() -> Timing {
        Timing {
            commit_delay: Duration::from_millis(50),
            sync_interval: Duration::from_secs(3600),
            focus_min_gap: Duration::from_secs(3600),
            change_delay: Duration::from_millis(20),
            remote_delay: Duration::from_millis(20),
        }
    }

    fn engine(root: &Path, name: &str, remote: Option<&Path>) -> Arc<SyncEngine> {
        let git: Arc<CliGit> = Arc::new(crate::git::find_git().expect("git"));
        let config = SyncConfig::new(name);
        let clock = Arc::new(SystemClock);
        Arc::new(match remote {
            Some(url) => SyncEngine::clone_remote(git, url.to_str().unwrap(), root, config, clock).unwrap(),
            None => SyncEngine::init(git, root, config, clock).unwrap(),
        })
    }

    fn wait_until(mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !done() {
            assert!(Instant::now() < deadline, "timed out");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn commits_shortly_after_an_edit_without_a_remote() {
        let dir = tempfile::tempdir().unwrap();
        let engine = engine(dir.path(), "laptop", None);
        let events = Recorder::default();
        let worker = SyncWorker::start(engine.clone(), false, events.clone(), fast());
        events.wait_for("LocalOnly");
        assert_eq!(worker.last_status().map(|s| s.state), Some(SyncState::LocalOnly));

        let head = engine.head().unwrap();
        Workspace::new(dir.path()).create_page("New", None).unwrap();
        worker.edit_notifier()();
        wait_until(|| engine.head().unwrap() != head);
    }

    #[test]
    fn commits_pending_edits_when_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let engine = engine(dir.path(), "laptop", None);
        let mut timing = fast();
        timing.commit_delay = Duration::from_secs(3600);
        let worker = SyncWorker::start(engine.clone(), false, Recorder::default(), timing);
        let head = engine.head().unwrap();
        Workspace::new(dir.path()).create_page("New", None).unwrap();
        worker.edit_notifier()();
        drop(worker);
        assert_ne!(engine.head().unwrap(), head);
    }

    #[test]
    fn syncs_on_request_and_reports_changes_from_other_devices() {
        let dir = tempfile::tempdir().unwrap();
        let remote = dir.path().join("remote.git");
        let status = Command::new("git")
            .args(["init", "-q", "--bare", "-b", "main"])
            .arg(&remote)
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .status()
            .unwrap();
        assert!(status.success());
        let laptop = engine(&dir.path().join("laptop"), "laptop", Some(&remote));
        let desktop = engine(&dir.path().join("desktop"), "desktop", Some(&remote));

        let events = Recorder::default();
        let worker = SyncWorker::start(laptop.clone(), true, events.clone(), fast());
        events.wait_for("Synced");
        desktop.sync().unwrap();

        let page = Workspace::new(desktop.root())
            .create_page("From the desktop", None)
            .unwrap();
        desktop.sync().unwrap();
        events.clear();
        worker.sync_now();
        events.wait_for("changed");
        assert!(Workspace::new(laptop.root()).page_exists(&page));
    }

    #[test]
    fn reports_offline_with_the_reason() {
        let dir = tempfile::tempdir().unwrap();
        let engine = engine(dir.path(), "laptop", None);
        engine
            .set_remote(dir.path().join("missing.git").to_str().unwrap())
            .unwrap();
        let events = Recorder::default();
        let _worker = SyncWorker::start(engine, true, events.clone(), fast());
        events.wait_for("Offline");
    }

    #[test]
    fn tells_refused_access_from_offline() {
        assert_eq!(
            offline_state(
                "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
            ),
            SyncState::NoAccess
        );
        assert_eq!(
            offline_state(
                "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com"
            ),
            SyncState::Offline
        );
    }

    #[test]
    fn ignores_git_and_device_files() {
        assert!(is_workspace_file(Path::new("/w/pages/abc/page.md")));
        assert!(!is_workspace_file(Path::new("/w/.git/index.lock")));
        assert!(!is_workspace_file(Path::new("/w/.docsync/app.json")));
        assert!(!is_workspace_file(Path::new("/w/pages/abc/page.md.docsync-tmp")));
    }

    #[test]
    fn shortens_git_errors() {
        assert_eq!(
            first_line("fatal: repository 'x' not found\nmore\n"),
            "repository 'x' not found"
        );
        assert_eq!(first_line(""), "The remote can't be reached");
    }
}
