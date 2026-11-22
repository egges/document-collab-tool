//! An open workspace: the sync engine, its worker thread and a file watcher.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use docsync::{RemoteLayout, SyncConfig, SyncEngine, SystemClock, Workspace, layout};
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

/// This copy of a workspace: the app install plus its folder.
fn copy_key(root: &Path) -> String {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let install = INSTALL_ID.get().map(String::as_str).unwrap_or("tests");
    format!("{install} {}", root.display())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub path: String,
    pub name: String,
    pub device: String,
    pub remote: Option<String>,
    /// Where it's kept besides this device, for the sync panel:
    /// "Dropbox › Work", "GitHub", "gitlab.com".
    pub kept_in: Option<String>,
    /// The cloud folder the workspace's own folder is in, which damages it
    /// (see "Never a working copy inside a cloud folder").
    pub inside_cloud: Option<String>,
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
        let config = SyncConfig::new(device_name());
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
        let mut config = SyncConfig::new(device_name());
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
                engine.config().device_name,
                settings.remote.as_deref().unwrap_or("none")
            ),
        );
        let info = WorkspaceInfo {
            path: root.display().to_string(),
            name: String::new(),
            device: engine.config().device_name.clone(),
            remote: settings.remote.clone(),
            kept_in: settings.remote.as_deref().map(kept_in),
            inside_cloud: cloud::containing(&root, &cloud::detect()).map(|f| f.name),
        };
        if let Some(cloud) = &info.inside_cloud {
            devlog::warn("cloud", format!("The workspace's folder is inside {cloud}"));
        }
        if let Some(user) = crate::github::user() {
            engine.set_author(user.display_name(), user.noreply_email());
        }
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
        WorkspaceInfo {
            name: Workspace::new(root).name().unwrap_or_else(|| folder_label(root)),
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

    /// Who new commits are by: the GitHub account when signed in, otherwise
    /// this device, as before signing in.
    pub fn set_author(&self, user: Option<&crate::github::GitHubUser>) {
        let config = self.engine.config();
        match user {
            Some(user) => self.engine.set_author(user.display_name(), user.noreply_email()),
            None => self
                .engine
                .set_author(config.author_name.clone(), config.author_email.clone()),
        }
    }

    /// Set or clear the remote this device syncs with. Refuses a remote
    /// that holds a different workspace. This fetches, so the app runs
    /// [`SyncEngine::switch_remote`] itself without holding the session;
    /// see `commands::switch_remote`.
    pub fn set_remote(&mut self, url: Option<String>) -> Result<(), String> {
        let plan = self.plan_remote(url);
        if let Some(url) = &plan.url {
            self.engine
                .switch_remote(url, plan.layout.clone())
                .map_err(|e| e.to_string())?;
        }
        self.remote_switched(plan)
    }

    /// What syncing with `url` means for this copy: its settings and how
    /// history is shared there.
    pub fn plan_remote(&self, url: Option<String>) -> RemotePlan {
        let url = url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
        let mut settings = load_device_settings(self.engine.root());
        settings.remote = url.clone();
        let layout = remote_layout(&mut settings, self.engine.root());
        RemotePlan {
            url,
            layout,
            settings,
        }
    }

    /// After [`SyncEngine::switch_remote`] accepted `plan` (or for no
    /// remote): remember it, and sync and watch accordingly.
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
        self.watch_remote();
        Ok(())
    }
}

/// A remote to switch to: see [`Session::plan_remote`].
pub struct RemotePlan {
    pub url: Option<String>,
    pub layout: RemoteLayout,
    settings: DeviceSettings,
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

/// Shown in conflict blocks, e.g. "Arjans-MacBook-Pro".
fn device_name() -> String {
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
        let local = count(&root.join(".git"), "HEAD");

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
        assert_eq!(count(&second, &format!("refs/heads/devices/{device_id}")), local);
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
