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

/// Where a workspace is kept, as stored in `workspace.json` ("kept_in") so
/// that the other devices follow a move: see "Following a move" in
/// docs/sync-design.md. The same on every device, so a folder is described
/// by its cloud service and its path inside it, not where that is here:
/// - `folder:Dropbox/Work/Notes.docsync` in a cloud folder (the service
///   without its account, which differs per person);
/// - `folder:~/Backups/Notes.docsync` elsewhere in the home folder;
/// - `folder:/Volumes/USB/Notes.docsync` anywhere else;
/// - a Git URL as it is, without a password.
///
/// A folder remote's [`place_id`] goes at the end (`…/Notes.docsync#3f9a…`),
/// so only that folder counts as the place, not another with the same name.
pub fn portable_place(url: &str, folders: &[CloudFolder]) -> String {
    portable_place_with(url, folders, home().as_deref())
}

const FOLDER_PLACE: &str = "folder:";

fn portable_place_with(url: &str, folders: &[CloudFolder], home: Option<&Path>) -> String {
    if !is_folder_remote(url) {
        return without_password(url.trim());
    }
    let remote = folder_of(url);
    let place = folder_place(&remote, folders, home);
    match place_id(&remote) {
        Some(id) => format!("{place}#{id}"),
        None => place,
    }
}

fn folder_place(remote: &Path, folders: &[CloudFolder], home: Option<&Path>) -> String {
    let real = real_path(remote);
    let slashed = |rest: &Path| {
        rest.iter()
            .map(|c| c.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/")
    };
    for folder in folders {
        if let Ok(rest) = real.strip_prefix(real_path(&folder.path)) {
            return format!("{FOLDER_PLACE}{}/{}", service(&folder.name), slashed(rest));
        }
    }
    if let Some(home) = home
        && let Ok(rest) = real.strip_prefix(real_path(home))
    {
        return format!("{FOLDER_PLACE}~/{}", slashed(rest));
    }
    format!("{FOLDER_PLACE}{}", remote.display())
}

/// The file in a folder remote that holds its [`place_id`].
const PLACE_ID_FILE: &str = "place-id";

/// A random id for one folder remote, kept in it. The workspace's old
/// places keep their folders (and often their names) after a move, and a
/// folder shared with someone appears at another path for them, so the
/// id is what tells "the folder the workspace moved to" from the rest.
pub fn place_id(remote: &Path) -> Option<String> {
    let id = std::fs::read_to_string(remote.join(PLACE_ID_FILE)).ok()?;
    let id = id.trim();
    is_place_id(id).then(|| id.to_string())
}

fn is_place_id(id: &str) -> bool {
    id.len() == 16 && id.chars().all(|c| c.is_ascii_hexdigit())
}

/// The folder remote's [`place_id`], making it if it has none yet (folders
/// made before ids). Written once, as a temp file renamed into place.
pub fn ensure_place_id(remote: &Path) -> Result<String, String> {
    if let Some(id) = place_id(remote) {
        return Ok(id);
    }
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let file = remote.join(PLACE_ID_FILE);
    let temp = remote.join(format!("{PLACE_ID_FILE}{}", docsync::layout::TEMP_SUFFIX));
    std::fs::write(&temp, format!("{id}\n"))
        .and_then(|()| std::fs::rename(&temp, &file))
        .map_err(|e| format!("can't write {}: {e}", file.display()))?;
    Ok(id)
}

/// "Dropbox" for "Dropbox (Contoso)": the service, not the account.
fn service(cloud: &str) -> &str {
    cloud.split_once(" (").map_or(cloud, |(service, _)| service)
}

/// `https://ada:token@host/x.git` without `ada:token@`: credentials are
/// never synced.
fn without_password(url: &str) -> String {
    for scheme in ["https://", "http://"] {
        if let Some(rest) = url.strip_prefix(scheme) {
            let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
            if let Some((_, host)) = authority.rsplit_once('@') {
                return format!("{scheme}{host}/{path}").trim_end_matches('/').to_string();
            }
        }
    }
    url.to_string()
}

/// The remotes on this device that `place` (from [`portable_place`]) may
/// mean, most likely first. A Git URL is itself. A folder is looked for at
/// the same path in each cloud folder of that service, then by its name in
/// every cloud folder, since a folder someone shared with you usually
/// appears somewhere else in your Dropbox. Only folder remotes that are
/// there now.
pub fn place_candidates(place: &str, folders: &[CloudFolder]) -> Vec<String> {
    place_candidates_with(place, folders, home().as_deref())
}

fn place_candidates_with(place: &str, folders: &[CloudFolder], home: Option<&Path>) -> Vec<String> {
    let Some(rest) = place.strip_prefix(FOLDER_PLACE) else {
        return vec![place.to_string()];
    };
    let (rest, id) = split_place_id(rest);
    let mut paths: Vec<PathBuf> = Vec::new();
    if let Some(below_home) = rest.strip_prefix("~/") {
        paths.extend(home.map(|h| h.join(below_home)));
    } else if Path::new(rest).is_absolute() {
        paths.push(PathBuf::from(rest));
    } else if let Some((name, inside)) = rest.split_once('/') {
        paths.extend(
            folders
                .iter()
                .filter(|f| service(&f.name) == name)
                .map(|f| inside.split('/').fold(f.path.clone(), |p, part| p.join(part))),
        );
    }
    let mut found: Vec<PathBuf> = paths.into_iter().filter(|p| is_folder_remote_dir(p)).collect();
    // By name only with an id to check: otherwise any old copy would do.
    if id.is_some() {
        let name = rest.rsplit('/').next().unwrap_or(rest);
        for other in find_workspaces(folders) {
            let same_name = other
                .path
                .file_name()
                .is_some_and(|n| n.to_string_lossy() == name);
            if same_name && !found.iter().any(|p| same_folder(p, &other.path)) {
                found.push(other.path);
            }
        }
    }
    found.retain(|p| id.is_none() || place_id(p).as_deref() == id);
    found.into_iter().map(|p| p.display().to_string()).collect()
}

/// `Work/Notes.docsync#3f9a…` into the path and the [`place_id`].
fn split_place_id(place: &str) -> (&str, Option<&str>) {
    match place.rsplit_once('#') {
        Some((path, id)) if is_place_id(id) => (path, Some(id)),
        _ => (place, None),
    }
}

/// Whether two remotes are the same place: the same folder, or the same
/// Git repository however its URL is written.
pub fn same_remote(a: &str, b: &str) -> bool {
    if is_folder_remote(a) || is_folder_remote(b) {
        return is_folder_remote(a) && is_folder_remote(b) && same_folder(&folder_of(a), &folder_of(b));
    }
    if let (Some(a), Some(b)) = (crate::github::repo_from_url(a), crate::github::repo_from_url(b)) {
        return a.eq_ignore_ascii_case(&b);
    }
    let plain = |url: &str| {
        let url = without_password(url.trim());
        let url = url.trim_end_matches('/');
        url.strip_suffix(".git").unwrap_or(url).to_string()
    };
    plain(a) == plain(b)
}

fn same_folder(a: &Path, b: &Path) -> bool {
    real_path(a) == real_path(b)
}

/// For telling the user where a workspace moved: "Dropbox › Work",
/// "~/Backups", or `None` for a Git URL (the caller names those).
pub fn folder_place_label(place: &str) -> Option<String> {
    let (rest, _) = split_place_id(place.strip_prefix(FOLDER_PLACE)?);
    let parent = rest.rsplit_once('/').map_or(rest, |(parent, _)| parent);
    Some(if parent.starts_with('~') || Path::new(rest).is_absolute() {
        parent.to_string()
    } else {
        parent.replace('/', " › ")
    })
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

    #[test]
    fn describes_a_place_the_same_way_on_every_device() {
        let dir = tempfile::tempdir().unwrap();
        let ours = dir.path().join("ours");
        let theirs = dir.path().join("theirs");
        let dropbox = |home: &Path, account: &str| CloudFolder {
            name: account.into(),
            path: home.join("Library/CloudStorage/Dropbox"),
        };
        let here = [dropbox(&ours, "Dropbox (Contoso)")];
        let there = [dropbox(&theirs, "Dropbox")];
        let remote = here[0].path.join("Work").join("Notes.docsync");
        std::fs::create_dir_all(remote.join("objects")).unwrap();

        // Before it has an id (folders made before ids): just the path.
        let place = portable_place_with(&remote.display().to_string(), &here, Some(&ours));
        assert_eq!(place, "folder:Dropbox/Work/Notes.docsync");
        assert_eq!(
            place_candidates_with(&place, &here, Some(&ours)),
            [remote.display().to_string()]
        );

        let id = ensure_place_id(&remote).unwrap();
        assert_eq!(ensure_place_id(&remote).unwrap(), id, "made once");
        let place = portable_place_with(&remote.display().to_string(), &here, Some(&ours));
        assert_eq!(place, format!("folder:Dropbox/Work/Notes.docsync#{id}"));
        assert_eq!(folder_place_label(&place).as_deref(), Some("Dropbox › Work"));
        assert_eq!(
            place_candidates_with(&place, &here, Some(&ours)),
            [remote.display().to_string()]
        );

        // The same folder, as it syncs to another device.
        let arrive = |at: &Path| {
            std::fs::create_dir_all(at.join("objects")).unwrap();
            std::fs::copy(remote.join(PLACE_ID_FILE), at.join(PLACE_ID_FILE)).unwrap();
        };
        // Somewhere else in their Dropbox, as when someone shared it: found
        // by its name. An old place with the same name isn't.
        assert!(place_candidates_with(&place, &there, Some(&theirs)).is_empty());
        let old = there[0].path.join("Old").join("Notes.docsync");
        std::fs::create_dir_all(old.join("objects")).unwrap();
        ensure_place_id(&old).unwrap();
        assert!(place_candidates_with(&place, &there, Some(&theirs)).is_empty());
        let shared = there[0].path.join("Notes.docsync");
        arrive(&shared);
        assert_eq!(
            place_candidates_with(&place, &there, Some(&theirs)),
            [shared.display().to_string()]
        );
        // At the same path, that comes first.
        let same = there[0].path.join("Work").join("Notes.docsync");
        arrive(&same);
        assert_eq!(
            place_candidates_with(&place, &there, Some(&theirs)),
            [same.display().to_string(), shared.display().to_string()]
        );
        // But not when it's a different folder that happens to be there.
        std::fs::write(same.join(PLACE_ID_FILE), "0123456789abcdef\n").unwrap();
        assert_eq!(
            place_candidates_with(&place, &there, Some(&theirs)),
            [shared.display().to_string()]
        );
    }

    #[test]
    fn describes_folders_outside_cloud_folders_and_git_urls() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let backup = home.join("Backups").join("Notes.docsync");
        std::fs::create_dir_all(backup.join("objects")).unwrap();
        let place = portable_place_with(&backup.display().to_string(), &[], Some(&home));
        assert_eq!(place, "folder:~/Backups/Notes.docsync");
        assert_eq!(folder_place_label(&place).as_deref(), Some("~/Backups"));
        assert_eq!(
            place_candidates_with(&place, &[], Some(&home)),
            [backup.display().to_string()]
        );

        let elsewhere = dir.path().join("USB").join("Notes.docsync");
        let place = portable_place_with(&elsewhere.display().to_string(), &[], Some(&home));
        assert_eq!(place, format!("folder:{}", elsewhere.display()));
        assert!(
            place_candidates_with(&place, &[], Some(&home)).is_empty(),
            "not plugged in"
        );

        let url = "https://ada:secret@example.com/ada/notes.git";
        let place = portable_place_with(url, &[], Some(&home));
        assert_eq!(place, "https://example.com/ada/notes.git");
        assert_eq!(folder_place_label(&place), None);
        assert_eq!(
            place_candidates_with(&place, &[], Some(&home)),
            std::slice::from_ref(&place)
        );
    }

    #[test]
    fn tells_whether_two_remotes_are_the_same_place() {
        assert!(same_remote(
            "https://github.com/Ada/Notes.git",
            "git@github.com:ada/notes.git"
        ));
        assert!(!same_remote(
            "https://github.com/ada/notes.git",
            "https://github.com/ada/other.git"
        ));
        assert!(same_remote(
            "https://ada:secret@example.com/notes.git",
            "https://example.com/notes"
        ));
        assert!(!same_remote(
            "/Users/ada/Dropbox/Notes.docsync",
            "https://example.com/notes"
        ));
        assert!(same_remote(
            "/Users/ada/Dropbox/Notes.docsync",
            "file:///Users/ada/Dropbox/Notes.docsync"
        ));
    }
}
