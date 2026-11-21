//! An open workspace: the sync engine, its worker thread and a file watcher.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use docsync::{SyncConfig, SyncEngine, SystemClock, layout};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};

use crate::devlog;
use crate::worker::{Events, SyncWorker, Timing};

/// Per-device settings, in `.docsync/app.json` (never synced).
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct DeviceSettings {
    remote: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub path: String,
    pub name: String,
    pub device: String,
    pub remote: Option<String>,
}

pub struct Session {
    pub engine: Arc<SyncEngine>,
    pub worker: SyncWorker,
    info: WorkspaceInfo,
    _watcher: Option<RecommendedWatcher>,
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
            SyncEngine::init(git, path, config, clock)
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
        let engine = SyncEngine::clone_remote(
            git,
            url,
            path,
            SyncConfig::new(device_name()),
            Arc::new(SystemClock),
        )
        .map_err(|e| e.to_string())?;
        if !path.join(layout::WORKSPACE_FILE).is_file() {
            return Err(format!("{url} holds a Git repository, but not a workspace."));
        }
        save_device_settings(
            path,
            &DeviceSettings {
                remote: Some(url.to_string()),
            },
        )?;
        Self::start(engine, events)
    }

    fn start(engine: SyncEngine, events: impl Events) -> Result<Self, String> {
        let root = engine.root().to_path_buf();
        let settings = load_device_settings(&root);
        // The device settings are the source of truth for the remote; make
        // sure git agrees, even if someone edited one of them by hand.
        if let Some(url) = &settings.remote {
            engine.set_remote(url).map_err(|e| e.to_string())?;
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
            name: root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Workspace".into()),
            device: engine.config().device_name.clone(),
            remote: settings.remote.clone(),
        };
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

        Ok(Self {
            engine,
            worker,
            info,
            _watcher: watcher,
        })
    }

    pub fn info(&self) -> &WorkspaceInfo {
        &self.info
    }

    /// Set or clear the remote this device syncs with.
    pub fn set_remote(&mut self, url: Option<String>) -> Result<(), String> {
        let url = url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
        if let Some(url) = &url {
            self.engine.set_remote(url).map_err(|e| e.to_string())?;
        }
        save_device_settings(self.engine.root(), &DeviceSettings { remote: url.clone() })?;
        devlog::info(
            "app",
            format!("Remote set to {}", url.as_deref().unwrap_or("none")),
        );
        self.worker.set_has_remote(url.is_some());
        self.info.remote = url;
        Ok(())
    }
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
    use docsync::Workspace;

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
