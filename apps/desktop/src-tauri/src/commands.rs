//! What the window can ask the Rust side to do. Every command that touches
//! git runs on a blocking thread, so the window never waits on the main
//! thread for a sync to finish.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use docsync::conflicts::find_conflicts;
use docsync::{PageWrite, SyncEngine, Workspace};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::devlog::{self, Entry, Level};
use crate::github::{self, Access, DeviceCode, GitHubUser, RemoteWorkspace};
use crate::locations;
use crate::search::{self, TextMatch};
use crate::session::{Session, WorkspaceInfo};
use crate::tree::{self, PageSummary};
use crate::worker::{Events, SyncStatus};
use crate::workspaces::{self, AppSettings, WorkspaceEntry};

type CmdResult<T> = Result<T, String>;

#[derive(Default)]
pub struct AppState {
    session: Mutex<Option<Session>>,
}

impl AppState {
    /// Signed in or out: new commits are by the new account.
    pub fn account_changed(&self) {
        if let Some(session) = self.session.lock().unwrap().as_ref() {
            session.set_author(github::user().as_ref());
        }
    }

    pub fn window_focused(&self) {
        if let Some(session) = self.session.lock().unwrap().as_ref() {
            session.worker.focused();
        }
    }

    /// The engine and a way to tell the worker about edits, without holding
    /// the lock while git runs.
    fn engine(&self) -> CmdResult<(Arc<SyncEngine>, impl Fn() + Send + 'static)> {
        let guard = self.session.lock().unwrap();
        let session = guard.as_ref().ok_or("No workspace is open")?;
        let engine = session.engine.clone();
        let notify = session.worker.edit_notifier();
        Ok((engine, notify))
    }
}

/// Sends worker events to the window.
struct WindowEvents(AppHandle);

impl Events for WindowEvents {
    fn status(&self, status: &SyncStatus) {
        let _ = self.0.emit("sync-status", status);
    }
    fn workspace_changed(&self) {
        let _ = self.0.emit("workspace-changed", ());
    }
}

/// Run `f` on a blocking thread; a failure goes to the developer log too.
async fn blocking<T: Send + 'static>(
    command: &'static str,
    f: impl FnOnce() -> CmdResult<T> + Send + 'static,
) -> CmdResult<T> {
    let result = tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
    if let Err(e) = &result {
        devlog::error("app", format!("{command} failed: {e}"));
    }
    result
}

fn text<E: ToString>(e: E) -> String {
    e.to_string()
}

// ---- app settings ------------------------------------------------------

/// Serialises reading and writing `settings.json`.
static SETTINGS: Mutex<()> = Mutex::new(());

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> AppSettings {
    let _guard = SETTINGS.lock().unwrap();
    settings_path(app)
        .map(|p| AppSettings::load(&p))
        .unwrap_or_default()
}

/// Change the settings and save them.
fn update_settings(app: &AppHandle, change: impl FnOnce(&mut AppSettings)) {
    let _guard = SETTINGS.lock().unwrap();
    let Some(path) = settings_path(app) else { return };
    let mut settings = AppSettings::load(&path);
    change(&mut settings);
    if let Err(e) = settings.save(&path) {
        devlog::warn("app", format!("Couldn't save {}: {e}", path.display()));
    }
}

// ---- workspaces ----------------------------------------------------------

fn install(app: &AppHandle, state: &AppState, session: Session) -> WorkspaceInfo {
    let info = session.info();
    let old = state.session.lock().unwrap().replace(session);
    // Stopping the old worker waits for a running sync, which may be stuck on
    // a slow network. Don't make the window wait for it.
    if let Some(old) = old {
        std::thread::spawn(move || drop(old));
    }
    update_settings(app, |s| {
        s.opened(Path::new(&info.path), &info.name, workspaces::now_ms())
    });
    info
}

/// The workspace that was open last time, if it still opens.
#[tauri::command]
pub async fn restore_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<Option<WorkspaceInfo>> {
    let Some(path) = load_settings(&app).last_workspace else {
        return Ok(None);
    };
    if !path.exists() {
        return Ok(None);
    }
    let events = WindowEvents(app.clone());
    match blocking("restore_workspace", move || {
        Session::open_or_create(&path, events)
    })
    .await
    {
        Ok(session) => Ok(Some(install(&app, &state, session))),
        Err(e) => {
            eprintln!("couldn't reopen the last workspace: {e}");
            Ok(None)
        }
    }
}

#[tauri::command]
pub async fn open_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
) -> CmdResult<WorkspaceInfo> {
    let events = WindowEvents(app.clone());
    let session = blocking("open_workspace", move || Session::open_or_create(&path, events)).await?;
    Ok(install(&app, &state, session))
}

#[tauri::command]
pub async fn clone_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    path: PathBuf,
) -> CmdResult<WorkspaceInfo> {
    let events = WindowEvents(app.clone());
    let session = blocking("clone_workspace", move || {
        Session::clone_remote(url.trim(), &path, events)
    })
    .await?;
    Ok(install(&app, &state, session))
}

/// The folder new workspaces go in unless the user picks one; see `locations`.
fn workspaces_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("workspaces"))
        .map_err(|e| format!("Can't find the app's data folder: {e}"))
}

/// Run `make` on a new folder; remove the folder again if that fails, so a
/// failed attempt doesn't leave "My Notes" behind and push the next try to
/// "My Notes 2".
fn in_new_folder(
    path: PathBuf,
    make: impl FnOnce(&std::path::Path) -> CmdResult<Session>,
) -> CmdResult<Session> {
    let result = make(&path);
    if result.is_err() && path.exists() {
        let _ = std::fs::remove_dir_all(&path);
    }
    result
}

/// Create a workspace called `name` in the default location.
#[tauri::command]
pub async fn create_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> CmdResult<WorkspaceInfo> {
    let session = new_local_workspace(&app, "create_workspace", name).await?;
    Ok(install(&app, &state, session))
}

async fn new_local_workspace(app: &AppHandle, command: &'static str, name: String) -> CmdResult<Session> {
    let path = locations::new_workspace_dir(&workspaces_dir(app)?, &name);
    let events = WindowEvents(app.clone());
    blocking(command, move || {
        in_new_folder(path, |p| {
            let session = Session::open_or_create(p, events)?;
            // The folder name is a cleaned-up version; keep what they typed.
            if !name.trim().is_empty() {
                session.rename(&name)?;
            }
            Ok(session)
        })
    })
    .await
}

/// Join the workspace at `url`, keeping this device's copy in the default
/// location.
#[tauri::command]
pub async fn join_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> CmdResult<WorkspaceInfo> {
    let url = url.trim().to_string();
    let path = locations::new_workspace_dir(&workspaces_dir(&app)?, &locations::name_from_url(&url));
    let events = WindowEvents(app.clone());
    let session = blocking("join_workspace", move || {
        in_new_folder(path, |p| Session::clone_remote(&url, p, events))
    })
    .await?;
    Ok(install(&app, &state, session))
}

/// The open workspace, read fresh: its name may have changed with a sync.
#[tauri::command]
pub async fn workspace_info(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Option<WorkspaceInfo>> {
    let info = state.session.lock().unwrap().as_ref().map(Session::info);
    if let Some(info) = &info {
        update_settings(&app, |s| s.renamed(Path::new(&info.path), &info.name));
    }
    Ok(info)
}

/// Rename the open workspace on every device. Folders and remotes keep their
/// names.
#[tauri::command]
pub async fn rename_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> CmdResult<WorkspaceInfo> {
    let info = {
        let guard = state.session.lock().unwrap();
        guard.as_ref().ok_or("No workspace is open")?.rename(&name)?
    };
    update_settings(&app, |s| s.renamed(Path::new(&info.path), &info.name));
    Ok(info)
}

/// Show the open workspace's folder in Finder, Explorer or the file manager.
#[tauri::command]
pub async fn show_workspace_folder(state: State<'_, AppState>) -> CmdResult<()> {
    let (engine, _) = state.engine()?;
    blocking("show_workspace_folder", move || {
        tauri_plugin_opener::reveal_item_in_dir(engine.root()).map_err(text)
    })
    .await
}

#[tauri::command]
pub async fn close_workspace(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(session) = state.session.lock().unwrap().take() {
        // Commits pending edits once a running sync is done; see `install`.
        std::thread::spawn(move || drop(session));
    }
    update_settings(&app, |s| s.last_workspace = None);
    Ok(())
}

/// The workspaces this device knows, most recently opened first.
#[tauri::command]
pub async fn list_workspaces(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Vec<WorkspaceEntry>> {
    let current = state
        .session
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| s.engine.root().to_path_buf());
    let mut entries = load_settings(&app).entries();
    for entry in &mut entries {
        entry.current = current
            .as_deref()
            .is_some_and(|c| workspaces::same(c, Path::new(&entry.path)));
    }
    Ok(entries)
}

/// Take a workspace off the list. Its files stay where they are.
#[tauri::command]
pub async fn forget_workspace(app: AppHandle, path: PathBuf) -> CmdResult<()> {
    update_settings(&app, |s| s.forget(&path));
    devlog::info(
        "app",
        format!("Removed {} from the workspace list", path.display()),
    );
    Ok(())
}

/// The workspace listed at `from` is now in `to` (moved outside the app, or
/// on a drive that's mounted elsewhere): open it there.
#[tauri::command]
pub async fn locate_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    from: PathBuf,
    to: PathBuf,
) -> CmdResult<WorkspaceInfo> {
    if !workspaces::is_workspace(&to) {
        return Err(format!("{} doesn't hold a workspace.", to.display()));
    }
    let events = WindowEvents(app.clone());
    let opened = to.clone();
    let session = blocking("locate_workspace", move || {
        Session::open_or_create(&opened, events)
    })
    .await?;
    devlog::info("app", format!("Located {} at {}", from.display(), to.display()));
    // Before `install`, which puts the new location first.
    update_settings(&app, |s| s.relocated(&from, &to));
    Ok(install(&app, &state, session))
}

/// Move the open workspace into a new folder inside `parent`, named after
/// the workspace. Its history and sync settings move with it. If the move
/// fails, the workspace reopens where it was; either way the window should
/// ask `workspace_info` what's open afterwards.
#[tauri::command]
pub async fn move_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    parent: PathBuf,
) -> CmdResult<WorkspaceInfo> {
    let (from, name) = {
        let guard = state.session.lock().unwrap();
        let session = guard.as_ref().ok_or("No workspace is open")?;
        (session.engine.root().to_path_buf(), session.info().name)
    };
    let target = workspaces::move_target(&from, &parent, &name)?;
    let session = state
        .session
        .lock()
        .unwrap()
        .take()
        .ok_or("No workspace is open")?;
    let events = WindowEvents(app.clone());
    let (old, new) = (from.clone(), target.clone());
    let (moved, reopened) = blocking("move_workspace", move || {
        // Stop syncing and watching first. This waits for a running sync
        // and commits pending edits, so nothing writes while files move.
        drop(session);
        devlog::info(
            "app",
            format!("Moving {} to {}", from.display(), target.display()),
        );
        let moved = workspaces::move_dir(&from, &target).map_err(text);
        let reopened = Session::open_or_create(if moved.is_ok() { &target } else { &from }, events);
        Ok((moved, reopened))
    })
    .await?;
    if moved.is_ok() {
        devlog::info("app", format!("Moved the workspace to {}", new.display()));
        update_settings(&app, |s| s.relocated(&old, &new));
    }
    let info = reopened.map(|session| install(&app, &state, session));
    match moved {
        Ok(()) => info,
        Err(e) => {
            let message = format!("Couldn't move the workspace: {e}");
            devlog::error("app", &message);
            Err(message)
        }
    }
}

/// What deleting the open workspace would mean, for the confirmation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletionInfo {
    name: String,
    path: String,
    remote: Option<String>,
    /// "owner/repo" when the remote is a GitHub repository the app can reach
    /// (and so could delete).
    github_repo: Option<String>,
    /// Changes that aren't on the remote, or no remote at all: deleting the
    /// folder would lose them.
    unsynced: bool,
}

#[tauri::command]
pub async fn workspace_deletion_info(state: State<'_, AppState>) -> CmdResult<DeletionInfo> {
    let info = {
        let guard = state.session.lock().unwrap();
        guard.as_ref().ok_or("No workspace is open")?.info()
    };
    blocking("workspace_deletion_info", move || {
        let git = crate::git::find_git()?;
        let unsynced = workspaces::unsynced(git.binary(), Path::new(&info.path));
        let github_repo = info
            .remote
            .as_deref()
            .and_then(github::repo_from_url)
            .filter(|repo| github::user().is_some() && github::can_reach(repo).unwrap_or(false));
        Ok(DeletionInfo {
            name: info.name,
            path: info.path,
            remote: info.remote,
            github_repo,
            unsynced,
        })
    })
    .await
}

/// Delete the open workspace from this device: its folder goes to the
/// Trash and it leaves the list. With `delete_repo`, its GitHub repository
/// is deleted first (if that fails, nothing else happens). Then the most
/// recently opened other workspace opens; `None` when there's none.
#[tauri::command]
pub async fn delete_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    delete_repo: bool,
) -> CmdResult<Option<WorkspaceInfo>> {
    let (root, remote) = {
        let guard = state.session.lock().unwrap();
        let session = guard.as_ref().ok_or("No workspace is open")?;
        (session.engine.root().to_path_buf(), session.info().remote)
    };
    if delete_repo {
        let repo = remote
            .as_deref()
            .and_then(github::repo_from_url)
            .ok_or("This workspace doesn't sync with a GitHub repository.")?;
        blocking("delete_workspace", move || github::delete_repo(&repo)).await?;
    }
    let session = state
        .session
        .lock()
        .unwrap()
        .take()
        .ok_or("No workspace is open")?;
    let events = WindowEvents(app.clone());
    let folder = root.clone();
    let trashed = blocking("delete_workspace", move || {
        // Stop syncing and watching before the files go.
        drop(session);
        match trash::delete(&folder) {
            Ok(()) => Ok(Ok(())),
            // Keep it open rather than leave the window with nothing.
            Err(e) => Ok(Err((
                format!("Couldn't move {} to the Trash: {e}", folder.display()),
                Session::open_or_create(&folder, events),
            ))),
        }
    })
    .await?;
    if let Err((message, reopened)) = trashed {
        if let Ok(session) = reopened {
            install(&app, &state, session);
        }
        return Err(message);
    }
    devlog::info("app", format!("Moved {} to the Trash", root.display()));
    update_settings(&app, |s| s.forget(&root));

    // Open the most recent other workspace that's still there.
    let next = load_settings(&app)
        .entries()
        .into_iter()
        .find(|e| !e.missing)
        .map(|e| PathBuf::from(e.path));
    let Some(next) = next else { return Ok(None) };
    let events = WindowEvents(app.clone());
    match blocking("delete_workspace", move || Session::open_or_create(&next, events)).await {
        Ok(session) => Ok(Some(install(&app, &state, session))),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub async fn set_remote(state: State<'_, AppState>, url: Option<String>) -> CmdResult<WorkspaceInfo> {
    let mut guard = state.session.lock().unwrap();
    let session = guard.as_mut().ok_or("No workspace is open")?;
    session.set_remote(url)?;
    Ok(session.info())
}

#[tauri::command]
pub async fn sync_status(state: State<'_, AppState>) -> CmdResult<Option<SyncStatus>> {
    let guard = state.session.lock().unwrap();
    Ok(guard.as_ref().and_then(|s| s.worker.last_status()))
}

#[tauri::command]
pub async fn sync_now(state: State<'_, AppState>) -> CmdResult<()> {
    let guard = state.session.lock().unwrap();
    guard.as_ref().ok_or("No workspace is open")?.worker.sync_now();
    Ok(())
}

// ---- GitHub -------------------------------------------------------------

/// The signed-in GitHub account, if any.
#[tauri::command]
pub async fn github_account() -> CmdResult<Option<GitHubUser>> {
    blocking("github_account", || Ok(github::user())).await
}

/// The sign-in the window is showing, by an id the window picks, and its
/// code once GitHub has sent it. Starting again, or cancelling, moves
/// `current` on, which stops an earlier attempt's wait.
struct SignIn {
    current: Option<u64>,
    code: Option<(u64, DeviceCode)>,
}

static SIGN_IN: Mutex<SignIn> = Mutex::new(SignIn {
    current: None,
    code: None,
});

fn is_current(attempt: u64) -> bool {
    SIGN_IN.lock().unwrap().current == Some(attempt)
}

/// Start signing in: a code for the user to enter on GitHub.
#[tauri::command]
pub async fn github_sign_in_start(attempt: u64) -> CmdResult<DeviceCode> {
    SIGN_IN.lock().unwrap().current = Some(attempt);
    let code = blocking("github_sign_in_start", github::start_device_flow).await?;
    let mut sign_in = SIGN_IN.lock().unwrap();
    if sign_in.current != Some(attempt) {
        return Err("Signing in was cancelled".into());
    }
    sign_in.code = Some((attempt, code.clone()));
    Ok(code)
}

/// Wait until the user approves the code `attempt` got. `None` when
/// signing in was cancelled or started again.
#[tauri::command]
pub async fn github_sign_in_finish(
    state: State<'_, AppState>,
    attempt: u64,
) -> CmdResult<Option<GitHubUser>> {
    let code = match &SIGN_IN.lock().unwrap().code {
        Some((a, code)) if *a == attempt => code.clone(),
        _ => return Ok(None),
    };
    let user = blocking("github_sign_in_finish", move || {
        github::finish_device_flow(&code, || !is_current(attempt))
    })
    .await?;
    if user.is_some() {
        state.account_changed();
    }
    Ok(user)
}

#[tauri::command]
pub async fn github_sign_in_cancel(attempt: u64) -> CmdResult<()> {
    let mut sign_in = SIGN_IN.lock().unwrap();
    if sign_in.current == Some(attempt) {
        sign_in.current = None;
        sign_in.code = None;
    }
    Ok(())
}

#[tauri::command]
pub async fn github_sign_out(state: State<'_, AppState>) -> CmdResult<()> {
    blocking("github_sign_out", || {
        github::sign_out();
        Ok(())
    })
    .await?;
    state.account_changed();
    Ok(())
}

/// "browser" when this build signs in through the browser, "code" when it
/// uses the device flow (no client secret built in).
#[tauri::command]
pub async fn github_sign_in_mode() -> CmdResult<&'static str> {
    Ok(if github::browser_sign_in() {
        "browser"
    } else {
        "code"
    })
}

/// Sign in through the browser, then install the App if needed; emits
/// `github-sign-in-step` with "install" when the install page opens. `None`
/// when cancelled (with `github_sign_in_cancel(attempt)`).
#[tauri::command]
pub async fn github_sign_in_browser(
    app: AppHandle,
    state: State<'_, AppState>,
    attempt: u64,
) -> CmdResult<Option<GitHubUser>> {
    SIGN_IN.lock().unwrap().current = Some(attempt);
    let emitter = app.clone();
    let user = blocking("github_sign_in_browser", move || {
        github::sign_in_with_browser(
            |url| tauri_plugin_opener::open_url(url, None::<&str>).map_err(text),
            || {
                let _ = emitter.emit("github-sign-in-step", "install");
            },
            || !is_current(attempt),
        )
    })
    .await?;
    if user.is_some() {
        state.account_changed();
        // Back from the browser.
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
    Ok(user)
}

/// Workspaces in the repositories the App can reach, to join.
#[tauri::command]
pub async fn github_workspaces() -> CmdResult<Vec<RemoteWorkspace>> {
    blocking("github_workspaces", github::workspaces).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewGitHubWorkspace {
    workspace: WorkspaceInfo,
    /// The repository, unless creating it failed (then `problem` says why
    /// and the workspace is only on this device for now).
    full_name: Option<String>,
    problem: Option<String>,
    reachable: bool,
    manage_url: Option<String>,
}

/// A new workspace that syncs with a new private repository.
#[tauri::command]
pub async fn create_github_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> CmdResult<NewGitHubWorkspace> {
    let session = new_local_workspace(&app, "create_github_workspace", name).await?;
    let workspace_name = session.info().name;
    install(&app, &state, session);
    let created = blocking("create_github_workspace", move || {
        let repo = github::create_private_repo(&workspace_name)?;
        let reachable = github::can_reach(&repo.full_name).unwrap_or(true);
        let manage_url = github::access().ok().map(|a| a.manage_url);
        Ok((repo, reachable, manage_url))
    })
    .await;
    let mut guard = state.session.lock().unwrap();
    let session = guard.as_mut().ok_or("No workspace is open")?;
    Ok(match created {
        Ok((repo, reachable, manage_url)) => {
            session.set_remote(Some(repo.clone_url.clone()))?;
            session.worker.sync_now();
            NewGitHubWorkspace {
                workspace: session.info(),
                full_name: Some(repo.full_name),
                problem: None,
                reachable,
                manage_url,
            }
        }
        Err(problem) => NewGitHubWorkspace {
            workspace: session.info(),
            full_name: None,
            problem: Some(problem),
            reachable: false,
            manage_url: None,
        },
    })
}

/// Whether the GitHub App is installed on the user's account.
#[tauri::command]
pub async fn github_access() -> CmdResult<Access> {
    blocking("github_access", github::access).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedRepo {
    workspace: WorkspaceInfo,
    /// "ada/My-Notes".
    full_name: String,
    /// False when the App can't reach the new repository (it's installed on
    /// chosen repositories only): syncing waits until the user adds it.
    reachable: bool,
    manage_url: String,
}

/// Create a private GitHub repository for the open workspace and sync with it.
#[tauri::command]
pub async fn github_create_repo(state: State<'_, AppState>) -> CmdResult<CreatedRepo> {
    let name = {
        let guard = state.session.lock().unwrap();
        let session = guard.as_ref().ok_or("No workspace is open")?;
        if session.info().remote.is_some() {
            return Err("This workspace already syncs somewhere.".into());
        }
        session.info().name
    };
    let (repo, reachable, manage_url) = blocking("github_create_repo", move || {
        let repo = github::create_private_repo(&name)?;
        let reachable = github::can_reach(&repo.full_name).unwrap_or(true);
        let manage_url = github::access()
            .map(|a| a.manage_url)
            .unwrap_or_else(|_| github::install_url());
        Ok((repo, reachable, manage_url))
    })
    .await?;
    let mut guard = state.session.lock().unwrap();
    let session = guard.as_mut().ok_or("No workspace is open")?;
    session.set_remote(Some(repo.clone_url.clone()))?;
    session.worker.sync_now();
    Ok(CreatedRepo {
        workspace: session.info(),
        full_name: repo.full_name,
        reachable,
        manage_url,
    })
}

// ---- pages ---------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    id: String,
    title: String,
    body: String,
    conflicts: Vec<Conflict>,
}

#[derive(Debug, Serialize)]
pub struct Conflict {
    versions: Vec<ConflictVersion>,
}

#[derive(Debug, Serialize)]
pub struct ConflictVersion {
    label: String,
    text: String,
}

fn conflicts_in(body: &str) -> Vec<Conflict> {
    find_conflicts(body)
        .into_iter()
        .map(|block| Conflict {
            versions: block
                .versions
                .into_iter()
                .map(|v| ConflictVersion {
                    label: v.label,
                    text: v.text,
                })
                .collect(),
        })
        .collect()
}

fn read_page_from(ws: &Workspace, id: &str) -> CmdResult<Page> {
    let meta = ws.read_page_meta(id).unwrap_or_default();
    let body = ws.read_body(id).unwrap_or_default();
    if !ws.page_exists(id) {
        return Err("This page no longer exists.".into());
    }
    Ok(Page {
        id: id.to_string(),
        title: meta["title"].as_str().unwrap_or_default().to_string(),
        conflicts: conflicts_in(&body),
        body,
    })
}

#[tauri::command]
pub async fn list_pages(state: State<'_, AppState>) -> CmdResult<Vec<PageSummary>> {
    let (engine, _) = state.engine()?;
    blocking("list_pages", move || {
        tree::list_pages(&Workspace::new(engine.root())).map_err(text)
    })
    .await
}

#[tauri::command]
pub async fn read_page(state: State<'_, AppState>, id: String) -> CmdResult<Page> {
    let (engine, _) = state.engine()?;
    blocking("read_page", move || {
        read_page_from(&Workspace::new(engine.root()), &id)
    })
    .await
}

/// Pages whose text contains `query`, for the search palette.
#[tauri::command]
pub async fn search_text(state: State<'_, AppState>, query: String) -> CmdResult<Vec<TextMatch>> {
    let (engine, _) = state.engine()?;
    blocking("search_text", move || {
        search::search_text(&Workspace::new(engine.root()), &query, 50).map_err(text)
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum WriteResult {
    /// Written as given. `conflicts` are the blocks still in the page.
    Written {
        conflicts: Vec<Conflict>,
    },
    /// The page changed on disk meanwhile and was merged; reload `page`.
    Merged {
        page: Page,
    },
    Gone,
}

/// Save a page edited from `base` (the body as the editor loaded it).
#[tauri::command]
pub async fn write_page(
    state: State<'_, AppState>,
    id: String,
    base: String,
    body: String,
) -> CmdResult<WriteResult> {
    let (engine, edited) = state.engine()?;
    blocking("write_page", move || {
        let write = engine.write_page_body(&id, &base, &body).map_err(text)?;
        edited();
        match &write {
            PageWrite::Written => devlog::debug("save", format!("Wrote page {id} ({} chars)", body.len())),
            PageWrite::Merged { conflicts, .. } => devlog::info(
                "save",
                format!("Page {id} changed on disk since it was opened: merged both ({conflicts} conflicts)"),
            ),
            PageWrite::PageGone => {
                devlog::warn("save", format!("Page {id} was deleted elsewhere; not written"))
            }
        }
        Ok(match write {
            PageWrite::Written => WriteResult::Written {
                conflicts: conflicts_in(&body),
            },
            PageWrite::Merged { .. } => WriteResult::Merged {
                page: read_page_from(&Workspace::new(engine.root()), &id)?,
            },
            PageWrite::PageGone => WriteResult::Gone,
        })
    })
    .await
}

#[tauri::command]
pub async fn create_page(
    state: State<'_, AppState>,
    title: String,
    parent: Option<String>,
) -> CmdResult<String> {
    let (engine, edited) = state.engine()?;
    blocking("create_page", move || {
        let id = Workspace::new(engine.root())
            .create_page(&title, parent.as_deref())
            .map_err(text)?;
        devlog::info("app", format!("Created page {id}"));
        edited();
        Ok(id)
    })
    .await
}

#[tauri::command]
pub async fn rename_page(state: State<'_, AppState>, id: String, title: String) -> CmdResult<()> {
    let (engine, edited) = state.engine()?;
    blocking("rename_page", move || {
        Workspace::new(engine.root())
            .set_title(&id, &title)
            .map_err(text)?;
        devlog::debug("app", format!("Renamed page {id}"));
        edited();
        Ok(())
    })
    .await
}

/// Delete a page. Its child pages move to the top level.
#[tauri::command]
pub async fn delete_page(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let (engine, edited) = state.engine()?;
    blocking("delete_page", move || {
        Workspace::new(engine.root()).delete_page(&id).map_err(text)?;
        devlog::info("app", format!("Deleted page {id}"));
        edited();
        Ok(())
    })
    .await
}

/// Keep version `keep` of conflict block `index`, and return the page.
#[tauri::command]
pub async fn resolve_conflict(
    state: State<'_, AppState>,
    id: String,
    index: usize,
    keep: usize,
) -> CmdResult<Page> {
    let (engine, edited) = state.engine()?;
    blocking("resolve_conflict", move || {
        engine.resolve_page_conflict(&id, index, keep).map_err(text)?;
        devlog::info(
            "app",
            format!("Resolved conflict {index} on page {id}: kept version {keep}"),
        );
        edited();
        read_page_from(&Workspace::new(engine.root()), &id)
    })
    .await
}

// ---- developer panel ---------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevInfo {
    /// Whether the developer panel is available (debug builds, or DOCSYNC_DEV=1).
    enabled: bool,
    version: String,
    debug_build: bool,
    os: String,
    git: Option<String>,
    workspace: Option<WorkspaceInfo>,
}

#[tauri::command]
pub async fn dev_info(app: AppHandle, state: State<'_, AppState>) -> CmdResult<DevInfo> {
    let workspace = state.session.lock().unwrap().as_ref().map(Session::info);
    Ok(DevInfo {
        enabled: devlog::enabled(),
        version: app.package_info().version.to_string(),
        debug_build: cfg!(debug_assertions),
        os: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        git: crate::git::description(),
        workspace,
    })
}

#[tauri::command]
pub async fn dev_log_entries() -> CmdResult<Vec<Entry>> {
    Ok(devlog::entries())
}

#[tauri::command]
pub async fn dev_log_clear() -> CmdResult<()> {
    devlog::clear();
    Ok(())
}

/// An entry from the window (saves, reloads, errors it showed).
#[tauri::command]
pub async fn dev_log_add(level: Level, source: String, message: String) -> CmdResult<()> {
    devlog::log(level, &source, message);
    Ok(())
}
