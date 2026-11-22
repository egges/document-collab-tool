//! The workspaces this device knows about, and moving one to another folder.
//!
//! The list lives in the app's `settings.json` (per device, never synced),
//! with each workspace's name as last seen, so a workspace whose folder has
//! gone (moved in Finder, an unplugged drive) still shows by name with
//! "Locate…". See "Where workspaces live" in docs/sync-design.md.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use docsync::{Workspace, layout};
use serde::{Deserialize, Serialize};

use crate::locations;

/// The app's settings on this device, in `settings.json`.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// Reopened on start.
    #[serde(default)]
    pub last_workspace: Option<PathBuf>,
    #[serde(default)]
    pub workspaces: Vec<KnownWorkspace>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownWorkspace {
    pub path: PathBuf,
    /// As last seen, for when the folder is missing.
    pub name: String,
    /// Milliseconds since the Unix epoch.
    pub last_opened: u64,
}

/// A row in the workspace switcher.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub path: String,
    pub name: String,
    /// The folder is gone or no longer holds a workspace.
    pub missing: bool,
    /// The workspace open in the window.
    pub current: bool,
    pub last_opened: u64,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Whether `root` has work that isn't on its remote: uncommitted changes,
/// commits that weren't pushed, or no remote at all. Deleting it would lose
/// that work.
pub fn unsynced(git: &Path, root: &Path) -> bool {
    let run = |args: &[&str]| {
        std::process::Command::new(git)
            .arg("-C")
            .arg(root)
            .args(args)
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    };
    let changed = run(&["status", "--porcelain"]).is_none_or(|out| !out.is_empty());
    let unpushed = match run(&["rev-parse", "--verify", "-q", "refs/remotes/origin/main"]) {
        None => true,
        Some(_) => run(&["rev-list", "--count", "refs/remotes/origin/main..refs/heads/main"])
            .is_none_or(|n| n != "0"),
    };
    changed || unpushed
}

/// Whether `path` holds a workspace: a Git repository with `workspace.json`.
pub fn is_workspace(path: &Path) -> bool {
    path.join(".git").exists() && path.join(layout::WORKSPACE_FILE).is_file()
}

/// One spelling per folder, so the same workspace is never listed twice
/// (macOS reaches temp folders through `/private`, for example). A folder
/// that's gone is spelled through its nearest parent that still exists.
fn normalize(path: &Path) -> PathBuf {
    if let Ok(path) = fs::canonicalize(path) {
        return path;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => normalize(parent).join(name),
        _ => path.to_path_buf(),
    }
}

pub fn same(a: &Path, b: &Path) -> bool {
    normalize(a) == normalize(b)
}

impl AppSettings {
    pub fn load(path: &Path) -> Self {
        let mut settings: Self = fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        // Settings from before the list existed only had the last workspace.
        if let Some(last) = settings.last_workspace.clone()
            && !settings.workspaces.iter().any(|w| same(&w.path, &last))
        {
            let name = Workspace::new(&last)
                .name()
                .unwrap_or_else(|| folder_label(&last));
            settings.workspaces.push(KnownWorkspace {
                path: last,
                name,
                last_opened: 0,
            });
        }
        settings
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        fs::create_dir_all(path.parent().expect("has a parent"))?;
        fs::write(path, serde_json::to_vec_pretty(self).expect("serializable"))
    }

    /// `path` was opened as `name`: put it first and reopen it next time.
    pub fn opened(&mut self, path: &Path, name: &str, now: u64) {
        let path = normalize(path);
        self.workspaces.retain(|w| !same(&w.path, &path));
        self.workspaces.insert(
            0,
            KnownWorkspace {
                path: path.clone(),
                name: name.to_string(),
                last_opened: now,
            },
        );
        self.last_workspace = Some(path);
    }

    /// Keep the remembered name up to date (it may arrive with a sync).
    pub fn renamed(&mut self, path: &Path, name: &str) {
        for w in &mut self.workspaces {
            if same(&w.path, path) {
                w.name = name.to_string();
            }
        }
    }

    /// Take `path` off the list. Its files stay where they are.
    pub fn forget(&mut self, path: &Path) {
        self.workspaces.retain(|w| !same(&w.path, path));
        if self.last_workspace.as_deref().is_some_and(|l| same(l, path)) {
            self.last_workspace = None;
        }
    }

    /// The workspace in `from` now lives in `to` (moved, or located again).
    pub fn relocated(&mut self, from: &Path, to: &Path) {
        let to = normalize(to);
        // If `to` was already listed separately, the moved entry replaces it.
        self.workspaces
            .retain(|w| !same(&w.path, &to) || same(&w.path, from));
        for w in &mut self.workspaces {
            if same(&w.path, from) {
                w.path = to.clone();
            }
        }
        if self.last_workspace.as_deref().is_some_and(|l| same(l, from)) {
            self.last_workspace = Some(to);
        }
    }

    /// Most recently opened first. Names are read fresh where the folder is
    /// there, since another device may have renamed the workspace.
    pub fn entries(&self) -> Vec<WorkspaceEntry> {
        let mut entries: Vec<WorkspaceEntry> = self
            .workspaces
            .iter()
            .map(|w| {
                let present = is_workspace(&w.path);
                let name = present
                    .then(|| Workspace::new(&w.path).name())
                    .flatten()
                    .unwrap_or_else(|| w.name.clone());
                WorkspaceEntry {
                    path: w.path.display().to_string(),
                    name,
                    missing: !present,
                    current: false,
                    last_opened: w.last_opened,
                }
            })
            .collect();
        entries.sort_by_key(|e| std::cmp::Reverse(e.last_opened));
        entries
    }
}

/// The folder's name, for workspaces made before names were stored.
pub fn folder_label(root: &Path) -> String {
    root.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Workspace".into())
}

/// Where a workspace called `name` in `root` goes when moved into the folder
/// `parent`: a new folder named after it ("My Notes", or "My Notes 2" when
/// that's taken).
pub fn move_target(root: &Path, parent: &Path, name: &str) -> Result<PathBuf, String> {
    let root = normalize(root);
    let parent = normalize(parent);
    if parent.starts_with(&root) {
        return Err("A workspace can't be moved into its own folder.".into());
    }
    if root.parent() == Some(parent.as_path()) {
        return Err(format!("The workspace is already in {}.", parent.display()));
    }
    Ok(locations::new_workspace_dir(&parent, name))
}

/// Move the folder `from` to `to`, which must not exist yet. A rename when
/// both are on the same disk; otherwise a copy, then the original is removed.
/// If the copy fails, the original stays and the partial copy is removed.
pub fn move_dir(from: &Path, to: &Path) -> io::Result<()> {
    if to.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} already exists", to.display()),
        ));
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::rename(from, to) {
        Ok(()) => return Ok(()),
        // Different disks (EXDEV) and the like: fall back to copying. Other
        // errors (a file in use on Windows, no permission) are real.
        Err(e) if is_cross_device(&e) => {}
        Err(e) => return Err(e),
    }
    if let Err(e) = copy_dir(from, to) {
        let _ = fs::remove_dir_all(to);
        return Err(e);
    }
    fs::remove_dir_all(from)
}

fn is_cross_device(e: &io::Error) -> bool {
    // EXDEV is 18 on macOS and Linux; ERROR_NOT_SAME_DEVICE is 17 on Windows.
    e.kind() == io::ErrorKind::CrossesDevices
        || matches!(e.raw_os_error(), Some(18) if cfg!(unix))
        || matches!(e.raw_os_error(), Some(17) if cfg!(windows))
}

fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            // A link (nothing in a workspace should be one) is copied as
            // the file it points to.
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace_in(dir: &Path, name: &str) -> PathBuf {
        let root = dir.join(name);
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(
            root.join(layout::WORKSPACE_FILE),
            format!("{{\n  \"format\": 1,\n  \"name\": \"{name}\"\n}}\n"),
        )
        .unwrap();
        root
    }

    #[test]
    fn notices_work_that_would_be_lost() {
        let git = std::path::PathBuf::from("git");
        let run = |dir: &Path, args: &[&str]| {
            let ok = std::process::Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?}");
        };
        let dir = tempfile::tempdir().unwrap();
        let remote = dir.path().join("remote.git");
        let root = dir.path().join("ws");
        run(
            dir.path(),
            &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()],
        );
        run(dir.path(), &["init", "-q", "-b", "main", root.to_str().unwrap()]);
        fs::write(root.join("a.md"), "a").unwrap();
        run(&root, &["add", "-A"]);
        run(&root, &["commit", "-q", "-m", "a"]);
        assert!(unsynced(&git, &root), "never pushed");
        run(&root, &["remote", "add", "origin", remote.to_str().unwrap()]);
        run(&root, &["push", "-q", "origin", "main"]);
        assert!(!unsynced(&git, &root), "all pushed");
        fs::write(root.join("a.md"), "b").unwrap();
        assert!(unsynced(&git, &root), "uncommitted");
        run(&root, &["commit", "-qam", "b"]);
        assert!(unsynced(&git, &root), "not pushed");
    }

    #[test]
    fn remembers_workspaces_most_recent_first() {
        let dir = tempfile::tempdir().unwrap();
        let a = workspace_in(dir.path(), "A");
        let b = workspace_in(dir.path(), "B");
        let mut s = AppSettings::default();
        s.opened(&a, "A", 1);
        s.opened(&b, "B", 2);
        s.opened(&a, "A", 3);
        let names: Vec<_> = s.entries().into_iter().map(|e| e.name).collect();
        assert_eq!(names, ["A", "B"]);
        assert_eq!(s.workspaces.len(), 2, "reopening doesn't add a second entry");
        assert!(same(s.last_workspace.as_deref().unwrap(), &a));
    }

    #[test]
    fn a_missing_folder_keeps_its_last_known_name() {
        let dir = tempfile::tempdir().unwrap();
        let a = workspace_in(dir.path(), "A");
        let mut s = AppSettings::default();
        s.opened(&a, "Team notes", 1);
        // Renamed on another device: the fresh name wins while the folder is there.
        assert_eq!(s.entries()[0].name, "A");
        assert!(!s.entries()[0].missing);
        s.renamed(&a, "A");
        fs::remove_dir_all(&a).unwrap();
        let entry = &s.entries()[0];
        assert!(entry.missing);
        assert_eq!(entry.name, "A");
    }

    #[test]
    fn forgetting_and_locating() {
        let dir = tempfile::tempdir().unwrap();
        let a = workspace_in(dir.path(), "A");
        let mut s = AppSettings::default();
        s.opened(&a, "A", 1);
        let moved = dir.path().join("Elsewhere");
        fs::rename(&a, &moved).unwrap();
        s.relocated(&a, &moved);
        assert_eq!(s.workspaces.len(), 1);
        assert!(!s.entries()[0].missing);
        assert!(same(s.last_workspace.as_deref().unwrap(), &moved));
        s.forget(&moved);
        assert!(s.workspaces.is_empty());
        assert_eq!(s.last_workspace, None);
        assert!(moved.exists(), "forgetting leaves the files alone");
    }

    #[test]
    fn locating_onto_a_listed_folder_leaves_one_entry() {
        let dir = tempfile::tempdir().unwrap();
        let a = workspace_in(dir.path(), "A");
        let b = workspace_in(dir.path(), "B");
        let mut s = AppSettings::default();
        s.opened(&a, "A", 1);
        s.opened(&b, "B", 2);
        s.relocated(&a, &b);
        assert_eq!(s.workspaces.len(), 1);
    }

    #[test]
    fn old_settings_files_still_load() {
        let dir = tempfile::tempdir().unwrap();
        let a = workspace_in(dir.path(), "A");
        let file = dir.path().join("settings.json");
        fs::write(&file, serde_json::json!({ "lastWorkspace": a }).to_string()).unwrap();
        let s = AppSettings::load(&file);
        assert_eq!(s.entries()[0].name, "A");
        // And round-trip.
        s.save(&file).unwrap();
        assert_eq!(AppSettings::load(&file).workspaces, s.workspaces);
        // A missing or broken file is no settings.
        assert!(
            AppSettings::load(&dir.path().join("none.json"))
                .workspaces
                .is_empty()
        );
    }

    #[test]
    fn moving_a_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let a = workspace_in(dir.path(), "A");
        fs::create_dir_all(a.join("pages/p1")).unwrap();
        fs::write(a.join("pages/p1/page.md"), "Hello\n").unwrap();
        let dest = dir.path().join("Projects");
        fs::create_dir(&dest).unwrap();

        let target = move_target(&a, &dest, "Team Notes").unwrap();
        assert_eq!(target, normalize(&dest).join("Team Notes"));
        move_dir(&a, &target).unwrap();
        assert!(!a.exists());
        assert_eq!(
            fs::read_to_string(target.join("pages/p1/page.md")).unwrap(),
            "Hello\n"
        );
        assert!(is_workspace(&target));

        // Not into itself, not where it already is, never over a folder.
        assert!(move_target(&target, &target.join("pages"), "x").is_err());
        assert!(move_target(&target, &dest, "x").is_err());
        let taken = dest.join("Taken");
        fs::create_dir(&taken).unwrap();
        assert!(move_dir(&target, &taken).is_err());
        assert!(target.exists());
    }

    #[test]
    fn copying_keeps_every_file() {
        let dir = tempfile::tempdir().unwrap();
        let a = workspace_in(dir.path(), "A");
        fs::create_dir_all(a.join(".git/objects/ab")).unwrap();
        fs::write(a.join(".git/objects/ab/cdef"), [0u8, 1, 2]).unwrap();
        let copy = dir.path().join("Copy");
        copy_dir(&a, &copy).unwrap();
        assert_eq!(fs::read(copy.join(".git/objects/ab/cdef")).unwrap(), [0, 1, 2]);
        assert!(is_workspace(&copy));
    }
}
