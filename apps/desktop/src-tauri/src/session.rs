//! An open workspace: the sync engine, its worker thread and a file watcher.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use docsync::{RemoteCheck, RemoteLayout, SyncConfig, SyncEngine, SystemClock, Workspace, layout};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};

use crate::worker::{Events, SyncWorker, Timing};
use crate::workspaces::folder_label;
use crate::{cloud, devlog};

/// Per-device settings, in `.docsync/app.json` (never synced).
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct DeviceSettings {
    remote: Option<String>,
    /// Names this device's ref in a folder remote. Made when first needed;
    /// a copy made by joining again gets a new one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
    /// Which copy `device_id` was made for: this app install and the
    /// workspace's folder (see `copy_key`). A workspace folder that was
    /// copied, to another computer or next to itself, or restored from a
    /// backup, takes `app.json` along; it then gets an id of its own, since
    /// two copies writing one ref would overwrite each other.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    device_id_for: Option<String>,
    /// The last "kept_in" in `workspace.json` this copy acted on: written
    /// when it moved the workspace, or followed when another device did.
    /// A different one means the workspace moved since.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    followed: Option<String>,
}

static INSTALL_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Read this app install's random id from `config_dir`, making it on first
/// run. It's never synced or copied with a workspace.
pub fn init_install_id(config_dir: &Path) {
    let file = config_dir.join("install-id");
    let id = fs::read_to_string(&file)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            let mut bytes = [0u8; 8];
            getrandom::fill(&mut bytes).expect("random bytes");
            let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            let _ = fs::create_dir_all(config_dir).and_then(|()| fs::write(&file, &id));
            id
        });
    let _ = INSTALL_ID.set(id);
}

/// This app install's id; "tests" in tests, which don't make one.
fn install_id() -> &'static str {
    INSTALL_ID.get().map(String::as_str).unwrap_or("tests")
}

/// The settings every workspace opens with on this device.
fn sync_config() -> SyncConfig {
    let mut config = SyncConfig::new(device_name());
    // The install's id, so two devices with the same name are still told
    // apart, and a renamed one is still known.
    config.device_id = Some(install_id().to_string());
    config
}

/// This copy of a workspace: the app install plus its folder.
fn copy_key(root: &Path) -> String {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let install = install_id();
    format!("{install} {}", root.display())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub path: String,
    pub name: String,
    pub device: String,
    /// What tells this device apart from others with the same name: the
    /// app install's id. Conflict blocks record it with each version.
    pub device_id: String,
    /// Who new edits here are by (see `person.rs`), if anyone yet, with the
    /// id that conflict blocks record: whose versions are "You".
    pub person: Option<String>,
    pub person_id: Option<String>,
    pub remote: Option<String>,
    /// Where it's kept besides this device, for the sync panel:
    /// "Dropbox › Work", "GitHub", "gitlab.com".
    pub kept_in: Option<String>,
    /// The cloud folder the workspace's own folder is in, which damages it
    /// (see "Never a working copy inside a cloud folder").
    pub inside_cloud: Option<String>,
    /// Another device moved the workspace somewhere this device can't
    /// follow yet; until it can, it keeps syncing where it did.
    pub moved_to: Option<MovedTo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovedTo {
    /// "Dropbox › Work", "GitHub", "gitlab.com".
    pub label: String,
    /// A folder (offer "Locate…") rather than a Git repository.
    pub folder: bool,
}

pub struct Session {
    pub engine: Arc<SyncEngine>,
    pub worker: SyncWorker,
    info: WorkspaceInfo,
    _watcher: Option<RecommendedWatcher>,
    /// Watches a folder remote, to sync as soon as another device's
    /// changes arrive in it.
    remote_watcher: Option<RecommendedWatcher>,
}

impl Session {
    /// Open the workspace in `path`, or create one if the folder is empty or
    /// doesn't exist.
    pub fn open_or_create(path: &Path, events: impl Events) -> Result<Self, String> {
        let git = Arc::new(crate::git::find_git()?);
        let config = sync_config();
        let clock = Arc::new(SystemClock);
        let engine = if path.join(".git").exists() {
            if !path.join(layout::WORKSPACE_FILE).is_file() {
                return Err(format!(
                    "{} is a Git repository but not a workspace. Choose an empty folder to \
                     create a workspace in.",
                    path.display()
                ));
            }
            devlog::info("app", format!("Opening workspace {}", path.display()));
            SyncEngine::open(git, path, config, clock)
        } else if is_empty_dir(path)? {
            devlog::info("app", format!("Creating a workspace in {}", path.display()));
            SyncEngine::init(git, path, config, clock).and_then(|engine| {
                // Named after its folder until the user renames it.
                let name = folder_label(engine.root());
                Workspace::new(engine.root()).set_name(&name)?;
                Ok(engine)
            })
        } else {
            return Err(format!(
                "{} isn't empty. Choose an empty folder to create a workspace in, or a folder \
                 that already holds one.",
                path.display()
            ));
        }
        .map_err(|e| {
            devlog::error("app", format!("Couldn't open {}: {e}", path.display()));
            e.to_string()
        })?;
        Self::start(engine, events)
    }

    /// Join an existing workspace: clone `url` into the empty folder `path`.
    /// An empty remote gets a new workspace, published on the first sync.
    pub fn clone_remote(url: &str, path: &Path, events: impl Events) -> Result<Self, String> {
        if !is_empty_dir(path)? {
            return Err(format!("{} isn't empty. Choose an empty folder.", path.display()));
        }
        let git = Arc::new(crate::git::find_git()?);
        devlog::info("app", format!("Joining {url} in {}", path.display()));
        let mut settings = DeviceSettings {
            remote: Some(url.to_string()),
            ..DeviceSettings::default()
        };
        let mut config = sync_config();
        config.layout = remote_layout(&mut settings, path);
        let engine = SyncEngine::clone_remote(git, url, path, config, Arc::new(SystemClock))
            .map_err(|e| e.to_string())?;
        if !path.join(layout::WORKSPACE_FILE).is_file() {
            return Err(format!("{url} holds a Git repository, but not a workspace."));
        }
        save_device_settings(path, &settings)?;
        Self::start(engine, events)
    }

    fn start(engine: SyncEngine, events: impl Events) -> Result<Self, String> {
        let root = engine.root().to_path_buf();
        let mut settings = load_device_settings(&root);
        // The device settings are the source of truth for the remote; make
        // sure git agrees, even if someone edited one of them by hand.
        if let Some(url) = &settings.remote {
            engine.set_remote(url).map_err(|e| e.to_string())?;
        }
        let before = (settings.device_id.clone(), settings.device_id_for.clone());
        engine.set_remote_layout(remote_layout(&mut settings, &root));
        if (settings.device_id.clone(), settings.device_id_for.clone()) != before {
            save_device_settings(&root, &settings)?;
        }
        devlog::info(
            "app",
            format!(
                "Workspace open as \"{}\", remote: {}",
                engine.device_name(),
                settings.remote.as_deref().unwrap_or("none")
            ),
        );
        let info = WorkspaceInfo {
            path: root.display().to_string(),
            name: String::new(),
            device: engine.device_name(),
            device_id: install_id().to_string(),
            person: None,
            person_id: None,
            remote: settings.remote.clone(),
            kept_in: settings.remote.as_deref().map(kept_in),
            inside_cloud: cloud::containing(&root, &cloud::detect()).map(|f| f.name),
            moved_to: None,
        };
        if let Some(cloud) = &info.inside_cloud {
            devlog::warn("cloud", format!("The workspace's folder is inside {cloud}"));
        }
        engine.set_person(crate::person::person(
            crate::github::user().as_ref(),
            crate::person::linked(settings.remote.as_deref()),
        ));
        let engine = Arc::new(engine);
        let worker = SyncWorker::start(
            engine.clone(),
            settings.remote.is_some(),
            events,
            Timing::default(),
        );

        // Without a watcher the app still works; it just notices outside
        // edits on the next sync instead of right away.
        let notify = worker.file_change_notifier();
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            if let Ok(event) = event {
                let paths: Vec<&Path> = event.paths.iter().map(PathBuf::as_path).collect();
                notify(&paths);
            }
        })
        .and_then(|mut w| w.watch(&root, RecursiveMode::Recursive).map(|()| w))
        .map_err(|e| devlog::warn("watch", format!("Not watching {}: {e}", root.display())))
        .ok();

        let mut session = Self {
            engine,
            worker,
            info,
            _watcher: watcher,
            remote_watcher: None,
        };
        session.watch_remote();
        Ok(session)
    }

    /// For a folder remote: sync when another device's files arrive in it
    /// rather than at the next timed sync, and have iCloud download it.
    fn watch_remote(&mut self) {
        self.remote_watcher = None;
        let Some(url) = self.info.remote.as_deref().filter(|u| cloud::is_folder_remote(u)) else {
            return;
        };
        let folder = cloud::folder_of(url);
        cloud::request_download(&folder);
        let sync = self.worker.remote_change_notifier();
        self.remote_watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            if event.is_ok_and(|e| !e.kind.is_access()) {
                sync();
            }
        })
        .and_then(|mut w| w.watch(&folder, RecursiveMode::Recursive).map(|()| w))
        .map_err(|e| devlog::warn("watch", format!("Not watching {}: {e}", folder.display())))
        .ok();
    }

    /// The name is read from `workspace.json` each time, so a rename that
    /// arrived with a sync shows up.
    pub fn info(&self) -> WorkspaceInfo {
        let root = self.engine.root();
        let writer = self.engine.writer();
        WorkspaceInfo {
            name: Workspace::new(root).name().unwrap_or_else(|| folder_label(root)),
            person: writer.person,
            person_id: writer.person_id,
            ..self.info.clone()
        }
    }

    /// Rename the workspace on every device. The folder and the remote keep
    /// their names; see "Where workspaces live" in docs/sync-design.md.
    pub fn rename(&self, name: &str) -> Result<WorkspaceInfo, String> {
        Workspace::new(self.engine.root())
            .set_name(name)
            .map_err(|e| e.to_string())?;
        devlog::info("app", format!("Renamed the workspace to \"{}\"", name.trim()));
        self.worker.edit_notifier()();
        Ok(self.info())
    }

    /// Work out again who new commits are by (see `person.rs`): after
    /// signing in or out, changing the name, or moving the workspace
    /// between a Git repository and a cloud folder.
    pub fn refresh_person(&self) {
        self.engine.set_person(crate::person::person(
            crate::github::user().as_ref(),
            crate::person::linked(self.info.remote.as_deref()),
        ));
    }

    /// This device was renamed (see [`set_device_name`]): new commits and
    /// conflict blocks use the new name.
    pub fn device_renamed(&mut self) {
        let name = device_name();
        devlog::info("app", format!("This device is now called \"{name}\""));
        self.engine.set_device_name(name.clone());
        self.info.device = name;
    }

    /// Set or clear the remote this device syncs with. Refuses a remote
    /// that holds a different workspace. This fetches, so the app runs
    /// [`prepare_move`] and [`SyncEngine::switch_remote`] itself without
    /// holding the session; see `commands::switch_remote`.
    pub fn set_remote(&mut self, url: Option<String>) -> Result<(), String> {
        let mut plan = self.plan_remote(url);
        if let Some(url) = plan.url.clone() {
            prepare_move(&self.engine, self.info.remote.as_deref(), &mut plan)?;
            self.engine
                .switch_remote(&url, plan.layout.clone())
                .map_err(|e| e.to_string())?;
        }
        self.remote_switched(plan)
    }

    /// What syncing with `url` means for this copy: its settings and how
    /// history is shared there.
    pub fn plan_remote(&self, url: Option<String>) -> RemotePlan {
        plan_remote(self.engine.root(), url)
    }

    /// After [`SyncEngine::switch_remote`] or [`follow`] accepted `plan`
    /// (or for no remote): remember it, and sync and watch accordingly.
    pub fn remote_switched(&mut self, plan: RemotePlan) -> Result<(), String> {
        let RemotePlan {
            url,
            layout,
            settings,
        } = plan;
        if url.is_none() {
            self.engine.set_remote_layout(layout);
        }
        save_device_settings(self.engine.root(), &settings)?;
        devlog::info(
            "app",
            format!("Remote set to {}", url.as_deref().unwrap_or("none")),
        );
        self.worker.set_has_remote(url.is_some());
        self.info.kept_in = url.as_deref().map(kept_in);
        self.info.remote = url;
        self.info.moved_to = None;
        self.refresh_person();
        self.watch_remote();
        Ok(())
    }

    /// Where another device moved the workspace, if this copy hasn't
    /// followed yet: the "kept_in" note from `workspace.json`. Cheap, so
    /// it runs after every sync. A copy that syncs nowhere has nothing to
    /// follow, and one that's already there only remembers that.
    pub fn pending_move(&mut self) -> Option<String> {
        let root = self.engine.root().to_path_buf();
        let note = Workspace::new(&root).kept_in();
        let mut settings = load_device_settings(&root);
        let pending = match (&note, &self.info.remote) {
            (Some(note), Some(current)) => {
                settings.followed.as_deref() != Some(note.as_str())
                    && !cloud::same_remote(&cloud::portable_place(current, &cloud::detect()), note)
            }
            _ => false,
        };
        if pending {
            return note;
        }
        self.info.moved_to = None;
        if note.is_some() && self.info.remote.is_some() && settings.followed != note {
            settings.followed = note;
            if let Err(e) = save_device_settings(&root, &settings) {
                devlog::warn("sync", e);
            }
        }
        None
    }

    /// After [`follow`]: switched to where the workspace moved, or say
    /// where that is when this device can't follow yet. Whether the info
    /// changed.
    pub fn moved(&mut self, note: &str, plan: Option<RemotePlan>) -> Result<bool, String> {
        if let Some(plan) = plan {
            let url = plan.url.clone().unwrap_or_default();
            let plan = plan.following(note);
            if self
                .info
                .remote
                .as_deref()
                .is_some_and(|r| cloud::same_remote(r, &url))
            {
                // Nothing to switch; just don't look again.
                save_device_settings(self.engine.root(), &plan.settings)?;
                let changed = self.info.moved_to.take().is_some();
                return Ok(changed);
            }
            self.remote_switched(plan)?;
            devlog::info("sync", format!("Followed the workspace to {url}"));
            self.worker.sync_now();
            return Ok(true);
        }
        let moved_to = Some(MovedTo {
            label: cloud::folder_place_label(note).unwrap_or_else(|| kept_in(note)),
            folder: cloud::folder_place_label(note).is_some(),
        });
        if self.info.moved_to == moved_to {
            return Ok(false);
        }
        devlog::info(
            "sync",
            format!("The workspace moved to {note}; can't follow it there yet"),
        );
        self.info.moved_to = moved_to;
        Ok(true)
    }

    /// [`Session::pending_move`], [`follow`] and [`Session::moved`] in one,
    /// holding the session throughout. For tests.
    #[cfg(test)]
    pub fn follow_move(&mut self) -> Result<bool, String> {
        let Some(note) = self.pending_move() else {
            return Ok(false);
        };
        let current = self.info.remote.clone();
        let plan = follow(&self.engine, &note, current.as_deref());
        self.moved(&note, plan)
    }
}

/// Before switching to `plan`'s remote: refuse one that holds a different
/// workspace, then leave a note where the workspace is kept now
/// ("kept_in" in `workspace.json`) and sync once more with the old remote,
/// so the devices still syncing there follow. If the old remote can't be
/// reached, they switch by hand; nothing is lost either way. Fetches, so
/// it runs without the session.
pub fn prepare_move(engine: &SyncEngine, old: Option<&str>, plan: &mut RemotePlan) -> Result<(), String> {
    let Some(url) = plan.url.clone() else {
        return Ok(());
    };
    let url = &url;
    match engine.check_remote(url, plan.layout.clone()) {
        Ok(RemoteCheck::OtherWorkspace) => {
            return Err(
                "That already holds a different workspace. Join that one instead, or choose an empty one."
                    .into(),
            );
        }
        Ok(_) => {}
        Err(e) => return Err(e.to_string()),
    }
    if cloud::is_folder_remote(url) {
        cloud::ensure_place_id(&cloud::folder_of(url))?;
    }
    let note = cloud::portable_place(url, &cloud::detect());
    plan.settings.followed = Some(note.clone());
    Workspace::new(engine.root())
        .set_kept_in(&note)
        .map_err(|e| e.to_string())?;
    if let Some(old) = old.filter(|old| !cloud::same_remote(old, url)) {
        match engine.sync() {
            Ok(report) if report.offline => devlog::warn(
                "sync",
                format!(
                    "Couldn't tell {old} where the workspace moved: {}",
                    report.offline_reason.unwrap_or_default()
                ),
            ),
            Ok(_) => devlog::info(
                "sync",
                format!("Left a note at {old} that the workspace moved to {note}"),
            ),
            Err(e) => devlog::warn(
                "sync",
                format!("Couldn't tell {old} where the workspace moved: {e}"),
            ),
        }
    }
    Ok(())
}

/// Look for where the workspace moved (`note`, from
/// [`Session::pending_move`]) and switch the engine there once it holds
/// this workspace: the remote may not have arrived yet, or this device
/// may not reach it (no Dropbox here, not signed in to GitHub). Then call
/// [`Session::moved`]. Fetches, so it runs without the session.
pub fn follow(engine: &SyncEngine, note: &str, current: Option<&str>) -> Option<RemotePlan> {
    let root = engine.root();
    for url in cloud::place_candidates(note, &cloud::detect()) {
        if current.is_some_and(|current| cloud::same_remote(current, &url)) {
            // Already there: a folder shared with this person is at another path.
            return Some(plan_remote(root, current.map(str::to_string)));
        }
        let plan = plan_remote(root, Some(url.clone()));
        match engine.follow_remote(&url, plan.layout.clone()) {
            Ok(RemoteCheck::SameWorkspace) => return Some(plan),
            Ok(check) => devlog::debug("sync", format!("Not following to {url} yet: {check:?}")),
            Err(e) => devlog::debug("sync", format!("Not following to {url} yet: {e}")),
        }
    }
    None
}

/// What syncing with `url` means for the copy in `root`: see
/// [`Session::plan_remote`].
fn plan_remote(root: &Path, url: Option<String>) -> RemotePlan {
    let url = url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
    let mut settings = load_device_settings(root);
    settings.remote = url.clone();
    if let Some(url) = &url {
        settings.followed = Some(cloud::portable_place(url, &cloud::detect()));
    }
    let layout = remote_layout(&mut settings, root);
    RemotePlan {
        url,
        layout,
        settings,
    }
}

/// A remote to switch to: see [`Session::plan_remote`].
pub struct RemotePlan {
    pub url: Option<String>,
    pub layout: RemoteLayout,
    settings: DeviceSettings,
}

impl RemotePlan {
    /// Switching because of `note`: remember that note as followed, even
    /// when this device writes the place differently (a shared folder at
    /// another path).
    fn following(mut self, note: &str) -> Self {
        self.settings.followed = Some(note.to_string());
        self
    }
}

/// Device refs for a folder remote (making this copy's id if it has none
/// yet, or one made for another copy), one shared branch for anything else.
fn remote_layout(settings: &mut DeviceSettings, root: &Path) -> RemoteLayout {
    match &settings.remote {
        Some(url) if cloud::is_folder_remote(url) => {
            let key = copy_key(root);
            if settings.device_id_for.as_deref() != Some(key.as_str()) {
                settings.device_id = None;
            }
            settings.device_id_for = Some(key);
            RemoteLayout::DeviceRefs {
                device_id: settings.device_id.get_or_insert_with(new_device_id).clone(),
            }
        }
        _ => RemoteLayout::SharedBranch,
    }
}

/// Readable in the folder remote, unique per copy: "arjans-macbook-pro-3f9a1c".
fn new_device_id() -> String {
    let mut bytes = [0u8; 3];
    getrandom::fill(&mut bytes).expect("random bytes");
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{hex}", layout::slug(&device_name()))
}

/// Where the workspace is kept, for "Kept in …": the folder a folder
/// remote is in ("Dropbox › Work", "~/Backups"), "GitHub" for a GitHub
/// repo, or a Git server's host.
fn kept_in(url: &str) -> String {
    if cloud::is_folder_remote(url) {
        let remote = cloud::folder_of(url);
        let folder = remote.parent().unwrap_or(&remote);
        return cloud::place(folder, &cloud::detect()).label;
    }
    if crate::github::repo_from_url(url).is_some() {
        return "GitHub".into();
    }
    // The host, e.g. "gitlab.com".
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let rest = rest.split_once('@').map_or(rest, |(_, rest)| rest);
    rest.split([':', '/']).next().unwrap_or(rest).to_string()
}

fn is_empty_dir(path: &Path) -> Result<bool, String> {
    match fs::read_dir(path) {
        // .DS_Store appears as soon as a Finder window shows the folder.
        Ok(mut entries) => Ok(entries.all(|e| e.is_ok_and(|e| e.file_name() == ".DS_Store"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(format!("can't read {}: {e}", path.display())),
    }
}

fn device_settings_path(root: &Path) -> PathBuf {
    root.join(".docsync").join("app.json")
}

fn load_device_settings(root: &Path) -> DeviceSettings {
    fs::read(device_settings_path(root))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_device_settings(root: &Path, settings: &DeviceSettings) -> Result<(), String> {
    let path = device_settings_path(root);
    fs::create_dir_all(path.parent().expect("has a parent"))
        .and_then(|()| fs::write(&path, serde_json::to_vec_pretty(settings).expect("serializable")))
        .map_err(|e| format!("can't save {}: {e}", path.display()))
}

/// The name the user gave this device in Settings, if any. For every
/// workspace on this device; kept in the app's `settings.json`.
static DEVICE_NAME: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Call this device `name` from now on, in every workspace, or go back to
/// the computer's own name with an empty one (or with that very name, so a
/// later change to the computer's name is followed). Returns what to keep
/// in the settings. An open workspace needs [`Session::device_renamed`].
pub fn set_device_name(name: Option<&str>) -> Option<String> {
    let name = name
        .map(crate::person::clean_name)
        .filter(|name| !name.is_empty() && *name != computer_name());
    *DEVICE_NAME.lock().unwrap() = name.clone();
    name
}

/// This device's name, shown with the person's in conflict blocks and
/// recorded in every commit: the one chosen in Settings, or else the
/// computer's, e.g. "Arjans-MacBook-Pro".
pub fn device_name() -> String {
    DEVICE_NAME.lock().unwrap().clone().unwrap_or_else(computer_name)
}

fn computer_name() -> String {
    let host = gethostname::gethostname().to_string_lossy().into_owned();
    let host = host.strip_suffix(".local").unwrap_or(&host).trim();
    if host.is_empty() {
        "This device".into()
    } else {
        host.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker::SyncStatus;

    struct NoEvents;
    impl Events for NoEvents {
        fn status(&self, _: &SyncStatus) {}
        fn workspace_changed(&self) {}
    }

    #[test]
    fn creates_a_workspace_in_an_empty_folder_and_reopens_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Notes");
        let session = Session::open_or_create(&root, NoEvents).unwrap();
        assert_eq!(session.info().name, "Notes");
        let page = Workspace::new(session.engine.root())
            .create_page("Hello", None)
            .unwrap();
        drop(session);

        let session = Session::open_or_create(&root, NoEvents).unwrap();
        assert!(Workspace::new(session.engine.root()).page_exists(&page));
    }

    #[test]
    fn renaming_the_device_names_its_next_edits() {
        let dir = tempfile::tempdir().unwrap();
        let mut session = Session::open_or_create(&dir.path().join("Notes"), NoEvents).unwrap();
        let computer = computer_name();

        // One line with single spaces; this is the only test that renames.
        let kept = set_device_name(Some("  Arjan's \n  Mac "));
        assert_eq!(kept.as_deref(), Some("Arjan's Mac"));
        session.device_renamed();
        assert_eq!(session.info().device, "Arjan's Mac");
        assert_eq!(session.engine.writer().device.as_deref(), Some("Arjan's Mac"));
        // Renaming keeps the id that tells this device apart.
        assert_eq!(session.engine.writer().device_id.as_deref(), Some("tests"));
        assert_eq!(session.info().device_id, "tests");

        // No name, or the computer's own, goes back to following the computer.
        for name in ["  ", computer.as_str()] {
            set_device_name(Some("Other"));
            assert_eq!(set_device_name(Some(name)), None);
            session.device_renamed();
            assert_eq!(session.info().device, computer);
        }
    }

    #[test]
    fn the_name_is_stored_in_the_workspace_not_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Notes");
        let session = Session::open_or_create(&root, NoEvents).unwrap();
        assert_eq!(Workspace::new(&root).name().as_deref(), Some("Notes"));
        assert_eq!(session.rename(" Team Notes ").unwrap().name, "Team Notes");
        assert!(session.rename("  ").is_err());
        drop(session);
        assert!(root.is_dir(), "the folder keeps its name");

        let session = Session::open_or_create(&root, NoEvents).unwrap();
        assert_eq!(session.info().name, "Team Notes");
        // A rename from another device shows up without reopening.
        Workspace::new(&root).set_name("Synced name").unwrap();
        assert_eq!(session.info().name, "Synced name");
    }

    #[test]
    fn workspaces_without_a_stored_name_use_the_folder_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Old workspace");
        drop(Session::open_or_create(&root, NoEvents).unwrap());
        fs::write(root.join(layout::WORKSPACE_FILE), "{\n  \"format\": 1\n}\n").unwrap();
        let session = Session::open_or_create(&root, NoEvents).unwrap();
        assert_eq!(session.info().name, "Old workspace");
    }

    #[test]
    fn refuses_folders_that_are_not_workspaces() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("thesis.docx"), b"").unwrap();
        let err = Session::open_or_create(dir.path(), NoEvents).err().unwrap();
        assert!(err.contains("isn't empty"), "{err}");

        let repo = tempfile::tempdir().unwrap();
        fs::create_dir(repo.path().join(".git")).unwrap();
        let err = Session::open_or_create(repo.path(), NoEvents).err().unwrap();
        assert!(err.contains("not a workspace"), "{err}");
    }

    #[test]
    fn a_docsync_folder_syncs_with_one_ref_per_device() {
        let dir = tempfile::tempdir().unwrap();
        let remote = dir.path().join("Dropbox").join("Notes.docsync");
        fs::create_dir_all(remote.parent().unwrap()).unwrap();
        let git = crate::git::find_git().unwrap();
        SyncEngine::create_folder_remote(&git, &remote).unwrap();

        let root = dir.path().join("Notes");
        let mut session = Session::open_or_create(&root, NoEvents).unwrap();
        session.set_remote(Some(remote.display().to_string())).unwrap();
        let RemoteLayout::DeviceRefs { device_id } = session.engine.remote_layout() else {
            panic!("expected device refs");
        };
        // The worker syncs at once too; either way it has published after this.
        session.engine.sync().unwrap();
        assert!(remote.join("refs/heads/devices").join(&device_id).is_file());
        drop(session);

        // The id is kept, so reopening publishes to the same ref.
        let session = Session::open_or_create(&root, NoEvents).unwrap();
        assert_eq!(
            session.engine.remote_layout(),
            RemoteLayout::DeviceRefs { device_id }
        );
    }

    #[test]
    fn a_copied_workspace_folder_gets_its_own_device_ref() {
        let dir = tempfile::tempdir().unwrap();
        let remote = dir.path().join("Dropbox").join("Notes.docsync");
        fs::create_dir_all(remote.parent().unwrap()).unwrap();
        let git = crate::git::find_git().unwrap();
        SyncEngine::create_folder_remote(&git, &remote).unwrap();
        let root = dir.path().join("Notes");
        let mut session = Session::open_or_create(&root, NoEvents).unwrap();
        session.set_remote(Some(remote.display().to_string())).unwrap();
        let original = session.engine.remote_layout();
        drop(session);

        // Copied in Finder, or restored from a backup: app.json comes along.
        let copy = dir.path().join("Notes copy");
        let status = std::process::Command::new("cp")
            .arg("-R")
            .arg(&root)
            .arg(&copy)
            .status()
            .unwrap();
        assert!(status.success());
        let session = Session::open_or_create(&copy, NoEvents).unwrap();
        let RemoteLayout::DeviceRefs { device_id } = session.engine.remote_layout() else {
            panic!("expected device refs");
        };
        assert_ne!(session.engine.remote_layout(), original);
        // And it keeps that one from now on.
        drop(session);
        let session = Session::open_or_create(&copy, NoEvents).unwrap();
        assert_eq!(
            session.engine.remote_layout(),
            RemoteLayout::DeviceRefs { device_id }
        );
    }

    #[test]
    fn switching_where_it_syncs_takes_the_history_along() {
        let dir = tempfile::tempdir().unwrap();
        let git = crate::git::find_git().unwrap();
        let count = |git_dir: &Path, rev: &str| {
            let out = std::process::Command::new("git")
                .arg("--git-dir")
                .arg(git_dir)
                .args(["rev-list", "--count", rev])
                .output()
                .unwrap();
            String::from_utf8(out.stdout).unwrap().trim().to_string()
        };

        let root = dir.path().join("Notes");
        let mut session = Session::open_or_create(&root, NoEvents).unwrap();
        for n in 0..3 {
            fs::write(root.join(format!("note-{n}.txt")), "hello").unwrap();
            session.engine.commit_local(&format!("Edit {n}")).unwrap();
        }

        // A folder remote first.
        let first = dir.path().join("Dropbox").join("Notes.docsync");
        fs::create_dir_all(first.parent().unwrap()).unwrap();
        SyncEngine::create_folder_remote(&git, &first).unwrap();
        session.set_remote(Some(first.display().to_string())).unwrap();
        // The worker syncs at once too; either way it has synced after this.
        session.engine.sync().unwrap();

        // Then a git server: the whole history goes there.
        let server = dir.path().join("server.git");
        let status = std::process::Command::new("git")
            .args(["init", "--bare", "-q", "-b", "main"])
            .arg(&server)
            .status()
            .unwrap();
        assert!(status.success());
        session.set_remote(Some(server.display().to_string())).unwrap();
        assert_eq!(session.engine.remote_layout(), RemoteLayout::SharedBranch);
        session.engine.sync().unwrap();
        // Everything, plus the note saying where it's kept now.
        let local = count(&root.join(".git"), "HEAD");
        assert_eq!(count(&server, "main"), local);

        // And back to a new folder remote, under the same device ref.
        let second = dir.path().join("OneDrive").join("Notes.docsync");
        fs::create_dir_all(second.parent().unwrap()).unwrap();
        SyncEngine::create_folder_remote(&git, &second).unwrap();
        session.set_remote(Some(second.display().to_string())).unwrap();
        let RemoteLayout::DeviceRefs { device_id } = session.engine.remote_layout() else {
            panic!("expected device refs");
        };
        session.engine.sync().unwrap();
        let local = count(&root.join(".git"), "HEAD");
        assert_eq!(count(&second, &format!("refs/heads/devices/{device_id}")), local);
    }

    #[test]
    fn other_devices_follow_when_the_workspace_moves() {
        let dir = tempfile::tempdir().unwrap();
        let git = crate::git::find_git().unwrap();
        let folder_remote = |name: &str| {
            let remote = dir.path().join(name).join("Notes.docsync");
            fs::create_dir_all(remote.parent().unwrap()).unwrap();
            SyncEngine::create_folder_remote(&git, &remote).unwrap();
            remote.display().to_string()
        };
        let first = folder_remote("Dropbox");
        let mut a = Session::open_or_create(&dir.path().join("a"), NoEvents).unwrap();
        a.set_remote(Some(first.clone())).unwrap();
        a.engine.sync().unwrap();
        let mut b = Session::clone_remote(&first, &dir.path().join("b"), NoEvents).unwrap();
        b.engine.sync().unwrap();
        assert_eq!(b.follow_move(), Ok(false), "already where the note says");

        // a moves it; the note reaches b through the old folder.
        let second = folder_remote("OneDrive");
        a.set_remote(Some(second.clone())).unwrap();
        b.engine.sync().unwrap();
        assert!(Workspace::new(b.engine.root()).kept_in().is_some());
        // a's worker may not have published there yet; once it has, b follows.
        a.engine.sync().unwrap();
        assert_eq!(b.follow_move(), Ok(true));
        assert_eq!(b.info().remote.as_deref(), Some(second.as_str()));
        assert!(b.info().moved_to.is_none());
        assert!(matches!(
            b.engine.remote_layout(),
            RemoteLayout::DeviceRefs { .. }
        ));
        assert_eq!(b.follow_move(), Ok(false), "only once");

        // Edits now go through the new folder.
        let page = Workspace::new(b.engine.root())
            .create_page("From b", None)
            .unwrap();
        b.engine.sync().unwrap();
        a.engine.sync().unwrap();
        assert!(Workspace::new(a.engine.root()).page_exists(&page));

        // A place b can't reach (a drive that isn't connected here): b says
        // so, and keeps syncing where it is.
        let third = folder_remote("USB");
        a.set_remote(Some(third.clone())).unwrap();
        a.engine.sync().unwrap();
        b.engine.sync().unwrap();
        fs::rename(dir.path().join("USB"), dir.path().join("USB unplugged")).unwrap();
        assert_eq!(b.follow_move(), Ok(true));
        let moved_to = b.info().moved_to.unwrap();
        assert!(moved_to.folder);
        assert!(moved_to.label.ends_with("USB"), "{}", moved_to.label);
        assert_eq!(b.info().remote.as_deref(), Some(second.as_str()));
        assert_eq!(b.follow_move(), Ok(false), "nothing new to say");

        // Plugged in again: b follows.
        fs::rename(dir.path().join("USB unplugged"), dir.path().join("USB")).unwrap();
        assert_eq!(b.follow_move(), Ok(true));
        assert_eq!(b.info().remote.as_deref(), Some(third.as_str()));
        assert!(b.info().moved_to.is_none());
    }

    /// The move-and-follow scenario against this computer's real Dropbox
    /// and OneDrive folders, as two copies of one workspace. It creates
    /// "Move test …" folders there and removes them afterwards. Run with
    /// `cargo test --lib real_cloud -- --ignored --nocapture`.
    #[test]
    #[ignore = "uses the real Dropbox and OneDrive folders"]
    fn real_cloud_folders_follow_a_move() {
        struct Cleanup(Vec<PathBuf>);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                // Deleting a folder Dropbox is still uploading makes it put
                // the folder back: let it finish first.
                std::thread::sleep(std::time::Duration::from_secs(15));
                for path in &self.0 {
                    let _ = fs::remove_dir_all(path);
                }
            }
        }
        let clouds = cloud::detect();
        let find = |service: &str| {
            clouds
                .iter()
                .find(|c| c.name.starts_with(service))
                .unwrap_or_else(|| panic!("no {service} folder on this computer"))
                .clone()
        };
        let (dropbox, onedrive) = (find("Dropbox"), find("OneDrive"));
        let git = crate::git::find_git().unwrap();
        let name = format!("Move test {}", &new_device_id()[..]);
        let home = PathBuf::from(std::env::var_os("HOME").unwrap());
        let drive = home.join("Desktop").join(format!("{name} drive"));
        let unplugged = home.join("Desktop").join(format!("{name} drive off"));
        let first = cloud::new_remote_path(&dropbox.path, &name);
        let second = cloud::new_remote_path(&onedrive.path, &name);
        let third = drive.join(format!("{name}.docsync"));
        let _cleanup = Cleanup(vec![
            first.clone(),
            second.clone(),
            drive.clone(),
            unplugged.clone(),
        ]);
        fs::create_dir_all(&drive).unwrap();
        for remote in [&first, &second, &third] {
            SyncEngine::create_folder_remote(&git, remote).unwrap();
        }
        let dir = tempfile::tempdir().unwrap();
        let path = |p: &Path| p.display().to_string();
        let kept_in = |s: &Session| Workspace::new(s.engine.root()).kept_in().unwrap_or_default();

        eprintln!("1. Copy A syncs through {}", path(&first));
        let mut a = Session::open_or_create(&dir.path().join("a"), NoEvents).unwrap();
        a.set_remote(Some(path(&first))).unwrap();
        a.engine.sync().unwrap();
        eprintln!("   note: {}", kept_in(&a));
        let mut b = Session::clone_remote(&path(&first), &dir.path().join("b"), NoEvents).unwrap();
        b.engine.sync().unwrap();
        eprintln!("   copy B joined; follows? {:?}", b.follow_move());

        eprintln!("2. Copy B moves it to {}", path(&second));
        b.set_remote(Some(path(&second))).unwrap();
        b.engine.sync().unwrap();
        a.engine.sync().unwrap();
        eprintln!("   copy A got the note: {}", kept_in(&a));
        assert_eq!(a.follow_move(), Ok(true));
        eprintln!(
            "   copy A now kept in {:?} ({:?})",
            a.info().kept_in,
            a.info().remote
        );
        assert_eq!(a.info().remote.as_deref(), Some(path(&second).as_str()));

        let page = Workspace::new(a.engine.root())
            .create_page("Written by A", None)
            .unwrap();
        a.engine.sync().unwrap();
        b.engine.sync().unwrap();
        eprintln!(
            "   a page from A reached B: {}",
            Workspace::new(b.engine.root()).page_exists(&page)
        );
        assert!(Workspace::new(b.engine.root()).page_exists(&page));

        eprintln!("3. Copy B moves it to {}, which is then unplugged", path(&third));
        b.set_remote(Some(path(&third))).unwrap();
        b.engine.sync().unwrap();
        a.engine.sync().unwrap();
        fs::rename(&drive, &unplugged).unwrap();
        assert_eq!(a.follow_move(), Ok(true));
        eprintln!("   copy A says: moved to {:?}", a.info().moved_to);
        eprintln!("   and keeps syncing through {:?}", a.info().kept_in);
        assert!(a.info().moved_to.is_some());
        assert_eq!(a.info().remote.as_deref(), Some(path(&second).as_str()));
        fs::rename(&unplugged, &drive).unwrap();
        assert_eq!(a.follow_move(), Ok(true));
        eprintln!(
            "   plugged in again: copy A kept in {:?}, notice {:?}",
            a.info().kept_in,
            a.info().moved_to
        );
        assert_eq!(a.info().remote.as_deref(), Some(path(&third).as_str()));

        eprintln!("4. Copy B stops syncing (On this computer): A stays put");
        b.set_remote(None).unwrap();
        a.engine.sync().unwrap();
        assert_eq!(a.follow_move(), Ok(false));
        assert_eq!(a.info().remote.as_deref(), Some(path(&third).as_str()));
        eprintln!("   copy A still kept in {:?}", a.info().kept_in);
        drop((a, b));
        eprintln!("Done; removing the test folders");
    }

    #[test]
    fn moving_to_a_different_workspaces_folder_leaves_no_note() {
        let dir = tempfile::tempdir().unwrap();
        let git = crate::git::find_git().unwrap();
        let theirs = dir.path().join("Dropbox").join("Theirs.docsync");
        fs::create_dir_all(theirs.parent().unwrap()).unwrap();
        SyncEngine::create_folder_remote(&git, &theirs).unwrap();
        let mut other = Session::open_or_create(&dir.path().join("other"), NoEvents).unwrap();
        other.set_remote(Some(theirs.display().to_string())).unwrap();
        other.engine.sync().unwrap();

        let mut ours = Session::open_or_create(&dir.path().join("ours"), NoEvents).unwrap();
        ours.engine.commit_local("Start").unwrap();
        let err = ours.set_remote(Some(theirs.display().to_string())).unwrap_err();
        assert!(err.contains("different workspace"), "{err}");
        assert_eq!(Workspace::new(ours.engine.root()).kept_in(), None);
        assert_eq!(ours.info().remote, None);
    }

    #[test]
    fn remembers_the_remote_per_device() {
        let dir = tempfile::tempdir().unwrap();
        let mut session = Session::open_or_create(dir.path(), NoEvents).unwrap();
        // A remote that doesn't exist: syncs fail at once, as when offline.
        let elsewhere = tempfile::tempdir().unwrap();
        let remote = elsewhere.path().join("missing.git").display().to_string();
        session.set_remote(Some(format!(" {remote} "))).unwrap();
        drop(session);
        let mut session = Session::open_or_create(dir.path(), NoEvents).unwrap();
        assert_eq!(session.info().remote.as_deref(), Some(remote.as_str()));
        session.set_remote(Some("  ".into())).unwrap();
        assert_eq!(session.info().remote, None);
        // Device settings are never synced.
        assert!(
            fs::read_to_string(dir.path().join(".gitignore"))
                .unwrap()
                .contains(".docsync/")
        );
    }
}
