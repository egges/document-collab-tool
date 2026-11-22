//! Folder remotes and the cloud folders they usually live in (iCloud Drive,
//! Dropbox, OneDrive, Google Drive, Box).
//!
//! A workspace syncs through a bare repository, `<name>.docsync`, in any
//! folder the user picks; see "Cloud folder remotes" in
//! docs/sync-design.md. Knowing the cloud folders is only a convenience:
//! shortcuts when picking a folder, finding workspaces to join, "Syncs via
//! Dropbox", and noticing a workspace whose own folder is inside one.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// The folder remote's extension, e.g. `My Notes.docsync`.
pub const EXTENSION: &str = "docsync";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudFolder {
    /// "Dropbox", "iCloud Drive", "OneDrive (Contoso)", ...
    pub name: String,
    pub path: PathBuf,
}

/// A folder remote found in a cloud folder, to join.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundWorkspace {
    pub name: String,
    pub path: PathBuf,
    /// The cloud folder it's in.
    pub cloud: String,
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// The cloud folders on this device, each once.
pub fn detect() -> Vec<CloudFolder> {
    let Some(home) = home() else { return Vec::new() };
    let mut found = Vec::new();
    #[cfg(target_os = "macos")]
    {
        let icloud = home.join("Library/Mobile Documents/com~apple~CloudDocs");
        if icloud.is_dir() {
            found.push(CloudFolder {
                name: "iCloud Drive".into(),
                path: icloud,
            });
        }
        found.extend(cloud_storage(&home.join("Library/CloudStorage")));
    }
    #[cfg(windows)]
    {
        let icloud = home.join("iCloudDrive");
        if icloud.is_dir() {
            found.push(CloudFolder {
                name: "iCloud Drive".into(),
                path: icloud,
            });
        }
        for (var, name) in [("OneDrive", "OneDrive"), ("OneDriveCommercial", "OneDrive")] {
            if let Some(path) = std::env::var_os(var).map(PathBuf::from)
                && path.is_dir()
            {
                found.push(CloudFolder {
                    name: name.into(),
                    path,
                });
            }
        }
    }
    found.extend(dropbox_folders(&home));
    dedupe(found)
}

/// macOS's File Provider folders: `Dropbox`, `OneDrive-Personal`,
/// `GoogleDrive-ada@example.com` (whose files are in "My Drive"), `Box-Box`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn cloud_storage(dir: &Path) -> Vec<CloudFolder> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<CloudFolder> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let folder = e.file_name().to_string_lossy().into_owned();
            let (service, account) = folder.split_once('-').unwrap_or((&folder, ""));
            let (name, path) = match service {
                "Dropbox" => ("Dropbox", e.path()),
                "OneDrive" => ("OneDrive", e.path()),
                "GoogleDrive" => ("Google Drive", e.path().join("My Drive")),
                "Box" => ("Box", e.path()),
                _ => return None,
            };
            let account = account.trim();
            let name = match account {
                "" | "Personal" | "Box" => name.to_string(),
                _ => format!("{name} ({account})"),
            };
            path.is_dir().then_some(CloudFolder { name, path })
        })
        .collect();
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

/// Dropbox says where its folders are in `info.json`.
fn dropbox_folders(home: &Path) -> Vec<CloudFolder> {
    let mut candidates = vec![home.join(".dropbox/info.json")];
    for var in ["LOCALAPPDATA", "APPDATA"] {
        if let Some(dir) = std::env::var_os(var) {
            candidates.push(PathBuf::from(dir).join("Dropbox/info.json"));
        }
    }
    let Some(info) = candidates
        .iter()
        .find_map(|p| std::fs::read(p).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
    else {
        return Vec::new();
    };
    dropbox_from_info(&info)
}

fn dropbox_from_info(info: &serde_json::Value) -> Vec<CloudFolder> {
    [("personal", "Dropbox"), ("business", "Dropbox (Business)")]
        .into_iter()
        .filter_map(|(key, name)| {
            let path = PathBuf::from(info[key]["path"].as_str()?);
            path.is_dir().then(|| CloudFolder {
                name: name.into(),
                path,
            })
        })
        .collect()
}

/// The same folder can be found twice, e.g. Dropbox through `info.json` and
/// `~/Library/CloudStorage`.
fn dedupe(folders: Vec<CloudFolder>) -> Vec<CloudFolder> {
    let mut seen = Vec::new();
    let mut out = Vec::new();
    for folder in folders {
        let real = folder.path.canonicalize().unwrap_or_else(|_| folder.path.clone());
        if !seen.contains(&real) {
            seen.push(real);
            out.push(folder);
        }
    }
    out
}

/// The cloud folder `path` is in, if any.
pub fn containing(path: &Path, folders: &[CloudFolder]) -> Option<CloudFolder> {
    let real = real_path(path);
    folders
        .iter()
        .find(|f| real.starts_with(real_path(&f.path)))
        .cloned()
}

/// `path` with symlinks resolved, also when its last part doesn't exist yet
/// (a folder remote about to be made).
fn real_path(path: &Path) -> PathBuf {
    if let Ok(real) = path.canonicalize() {
        return real;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => parent
            .canonicalize()
            .map(|p| p.join(name))
            .unwrap_or_else(|_| path.to_path_buf()),
        _ => path.to_path_buf(),
    }
}

/// Whether a remote URL is a folder remote: a `*.docsync` folder on this
/// device. Other local paths, like `/Volumes/USB/notes.git`, are ordinary
/// git remotes with one shared branch.
pub fn is_folder_remote(url: &str) -> bool {
    let url = url.trim();
    let local = url.starts_with("file://") || Path::new(url).is_absolute();
    local && folder_of(url).extension().is_some_and(|e| e == EXTENSION)
}

/// The folder a folder remote's URL points to.
pub fn folder_of(url: &str) -> PathBuf {
    let url = url.trim();
    PathBuf::from(url.strip_prefix("file://").unwrap_or(url))
}

/// How many levels below a folder to look for folder remotes, and in how
/// many folders at most, so that a large Dropbox doesn't make it slow.
const SEARCH_DEPTH: usize = 3;
const SEARCH_BUDGET: usize = 2000;

/// `*.docsync` folder remotes in each cloud folder, up to three levels
/// down: `Dropbox/Notes.docsync` or `Dropbox/Work/Team/Notes.docsync`.
pub fn find_workspaces(folders: &[CloudFolder]) -> Vec<FoundWorkspace> {
    let mut found = Vec::new();
    for folder in folders {
        search(&folder.path, &folder.name, &mut found);
    }
    found.sort_by_key(|a| a.name.to_lowercase());
    found
}

/// The folder remotes at `path`: itself when it is one, otherwise the ones
/// below it. For "Choose folder…" when joining.
pub fn workspaces_in(path: &Path, folders: &[CloudFolder]) -> Vec<FoundWorkspace> {
    let cloud = place(path, folders).cloud.unwrap_or_else(|| "this folder".into());
    if is_folder_remote_dir(path) {
        return vec![FoundWorkspace {
            name: workspace_name(path),
            path: path.to_path_buf(),
            cloud,
        }];
    }
    let mut found = Vec::new();
    search(path, &cloud, &mut found);
    found.sort_by_key(|a| a.name.to_lowercase());
    found
}

/// Breadth first, skipping hidden folders and symlinks, and never looking
/// inside a folder remote.
fn search(root: &Path, cloud: &str, found: &mut Vec<FoundWorkspace>) {
    let mut queue = VecDeque::from([(root.to_path_buf(), 0)]);
    let mut visited = 0;
    while let Some((dir, depth)) = queue.pop_front() {
        visited += 1;
        if visited > SEARCH_BUDGET {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let path = entry.path();
            if is_folder_remote_dir(&path) {
                found.push(FoundWorkspace {
                    name: workspace_name(&path),
                    path,
                    cloud: cloud.to_string(),
                });
            } else if depth < SEARCH_DEPTH && !is_hidden(&path) {
                queue.push_back((path, depth + 1));
            }
        }
    }
}

/// Where a folder is, to show before creating something there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPlace {
    /// The cloud folder it's in, if any.
    pub cloud: Option<String>,
    /// "Dropbox › Work › Notes.docsync", or "~/Shared/Notes.docsync"
    /// outside the cloud folders.
    pub label: String,
}

pub fn place(path: &Path, folders: &[CloudFolder]) -> FolderPlace {
    let real = real_path(path);
    for folder in folders {
        if let Ok(rest) = real.strip_prefix(real_path(&folder.path)) {
            let label = std::iter::once(folder.name.clone())
                .chain(rest.iter().map(|c| c.to_string_lossy().into_owned()))
                .collect::<Vec<_>>()
                .join(" › ");
            return FolderPlace {
                cloud: Some(folder.name.clone()),
                label,
            };
        }
    }
    let label = match home().and_then(|h| path.strip_prefix(&h).ok().map(Path::to_path_buf)) {
        Some(rest) if rest.as_os_str().is_empty() => "~".into(),
        Some(rest) => format!("~{}{}", std::path::MAIN_SEPARATOR, rest.display()),
        None => path.display().to_string(),
    };
    FolderPlace { cloud: None, label }
}

fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|n| n.to_string_lossy().starts_with('.'))
}

fn is_folder_remote_dir(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == EXTENSION) && path.join("objects").is_dir()
}

/// "My Notes" for `.../My Notes.docsync`.
pub fn workspace_name(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// A new folder remote's path in `folder`: "My Notes.docsync", then
/// "My Notes 2.docsync", and so on.
pub fn new_remote_path(folder: &Path, name: &str) -> PathBuf {
    let name = crate::locations::folder_name(name);
    let mut candidate = folder.join(format!("{name}.{EXTENSION}"));
    let mut n = 2;
    while candidate.exists() {
        candidate = folder.join(format!("{name} {n}.{EXTENSION}"));
        n += 1;
    }
    candidate
}

/// Ask iCloud Drive to download everything in `folder`, which it may have
/// removed locally to save space ("Optimize Mac Storage"). Until it has,
/// syncing treats the missing files as not arrived yet.
pub fn request_download(folder: &Path) {
    #[cfg(target_os = "macos")]
    if folder.to_string_lossy().contains("/Library/Mobile Documents/") {
        let folder = folder.to_path_buf();
        std::thread::spawn(move || {
            let result = std::process::Command::new("brctl")
                .arg("download")
                .arg(&folder)
                .output();
            if let Err(e) = result {
                crate::devlog::warn(
                    "cloud",
                    format!("Couldn't ask iCloud to download {}: {e}", folder.display()),
                );
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = folder;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_file_provider_folders() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "Dropbox",
            "OneDrive-Personal",
            "OneDrive-Contoso",
            "GoogleDrive-ada@example.com/My Drive",
            "Box-Box",
            "SomethingElse",
        ] {
            std::fs::create_dir_all(dir.path().join(name)).unwrap();
        }
        let names: Vec<String> = cloud_storage(dir.path()).into_iter().map(|f| f.name).collect();
        assert_eq!(
            names,
            [
                "Box",
                "Dropbox",
                "Google Drive (ada@example.com)",
                "OneDrive",
                "OneDrive (Contoso)"
            ]
        );
        let google = cloud_storage(dir.path())
            .into_iter()
            .find(|f| f.name.starts_with("Google"))
            .unwrap();
        assert!(google.path.ends_with("My Drive"));
    }

    #[test]
    fn reads_dropbox_info() {
        let dir = tempfile::tempdir().unwrap();
        let info = serde_json::json!({
            "personal": {"path": dir.path(), "host": 1},
            "business": {"path": "/nowhere/Dropbox (Contoso)"}
        });
        let found = dropbox_from_info(&info);
        assert_eq!(found.len(), 1, "the business folder doesn't exist");
        assert_eq!(found[0].name, "Dropbox");
    }

    #[test]
    fn finds_workspaces_in_cloud_folders() {
        let dir = tempfile::tempdir().unwrap();
        let cloud = dir.path().join("Dropbox");
        for remote in [
            "Notes.docsync",
            "Work/Team.docsync",
            "Work/Clients/Acme/Acme.docsync",
            ".hidden/Secret.docsync",
            "Notes.docsync/Inner.docsync",
            "a/b/c/d/TooDeep.docsync",
        ] {
            std::fs::create_dir_all(cloud.join(remote).join("objects")).unwrap();
        }
        // Not folder remotes: no objects folder, or a different extension.
        std::fs::create_dir_all(cloud.join("Empty.docsync")).unwrap();
        std::fs::create_dir_all(cloud.join("Photos/objects")).unwrap();
        let folders = [CloudFolder {
            name: "Dropbox".into(),
            path: cloud.clone(),
        }];
        let found = find_workspaces(&folders);
        let names: Vec<&str> = found.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["Acme", "Notes", "Team"]);
        assert_eq!(found[0].cloud, "Dropbox");
        assert_eq!(
            containing(&cloud.join("Notes.docsync"), &folders).map(|f| f.name),
            Some("Dropbox".into())
        );
        assert_eq!(containing(dir.path(), &folders), None);

        // Choosing a folder when joining: the remote itself, or those below.
        let picked = workspaces_in(&cloud.join("Work"), &folders);
        let names: Vec<&str> = picked.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["Acme", "Team"]);
        assert_eq!(workspaces_in(&cloud.join("Notes.docsync"), &folders).len(), 1);
    }

    #[test]
    fn describes_where_a_folder_is() {
        let dir = tempfile::tempdir().unwrap();
        let cloud = dir.path().join("Dropbox");
        std::fs::create_dir_all(cloud.join("Work")).unwrap();
        let folders = [CloudFolder {
            name: "Dropbox".into(),
            path: cloud.clone(),
        }];
        let inside = place(&cloud.join("Work").join("Notes.docsync"), &folders);
        assert_eq!(inside.cloud.as_deref(), Some("Dropbox"));
        assert_eq!(inside.label, "Dropbox › Work › Notes.docsync");
        assert_eq!(place(&cloud, &folders).label, "Dropbox");
        let outside = place(&dir.path().join("Elsewhere"), &folders);
        assert_eq!(outside.cloud, None);
    }

    #[test]
    fn tells_folder_remotes_from_servers() {
        assert!(is_folder_remote("/Users/ada/Dropbox/Notes.docsync"));
        assert!(is_folder_remote("file:///Users/ada/Dropbox/Notes.docsync"));
        assert!(!is_folder_remote("https://github.com/ada/notes.git"));
        assert!(!is_folder_remote("git@github.com:ada/notes.git"));
        assert!(!is_folder_remote("/Volumes/USB/notes.git"));
        assert!(is_folder_remote("/Users/ada/Dropbox/Notes.docsync/"));
        assert_eq!(
            folder_of("file:///Users/ada/Dropbox/Notes.docsync"),
            PathBuf::from("/Users/ada/Dropbox/Notes.docsync")
        );
    }

    #[test]
    fn names_new_folder_remotes() {
        let dir = tempfile::tempdir().unwrap();
        let first = new_remote_path(dir.path(), "My Notes");
        assert!(first.ends_with("My Notes.docsync"));
        std::fs::create_dir(&first).unwrap();
        assert!(new_remote_path(dir.path(), "My Notes").ends_with("My Notes 2.docsync"));
        assert_eq!(workspace_name(&first), "My Notes");
    }
}
