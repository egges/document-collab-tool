//! What the window can ask the Rust side to do. Every command that touches
//! git runs on a blocking thread, so the window never waits on the main
//! thread for a sync to finish.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use docsync::conflicts::find_conflicts;
use docsync::{PageWrite, SyncEngine, Workspace};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::session::{Session, WorkspaceInfo};
use crate::tree::{self, PageSummary};
use crate::worker::{Events, SyncStatus};

type CmdResult<T> = Result<T, String>;

#[derive(Default)]
pub struct AppState {
    session: Mutex<Option<Session>>,
}

impl AppState {
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

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

fn text<E: ToString>(e: E) -> String {
    e.to_string()
}

// ---- app settings ------------------------------------------------------

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    last_workspace: Option<PathBuf>,
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> AppSettings {
    settings_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, settings: &AppSettings) {
    if let Some(path) = settings_path(app) {
        let _ = std::fs::create_dir_all(path.parent().expect("has a parent"));
        let _ = std::fs::write(path, serde_json::to_vec_pretty(settings).expect("serializable"));
    }
}

// ---- workspaces ----------------------------------------------------------

fn install(app: &AppHandle, state: &AppState, session: Session) -> WorkspaceInfo {
    let info = session.info().clone();
    let old = state.session.lock().unwrap().replace(session);
    // Stopping the old worker waits for a running sync, which may be stuck on
    // a slow network. Don't make the window wait for it.
    if let Some(old) = old {
        std::thread::spawn(move || drop(old));
    }
    save_settings(
        app,
        &AppSettings {
            last_workspace: Some(PathBuf::from(&info.path)),
        },
    );
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
    match blocking(move || Session::open_or_create(&path, events)).await {
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
    let session = blocking(move || Session::open_or_create(&path, events)).await?;
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
    let session = blocking(move || Session::clone_remote(url.trim(), &path, events)).await?;
    Ok(install(&app, &state, session))
}

#[tauri::command]
pub async fn close_workspace(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(session) = state.session.lock().unwrap().take() {
        // Commits pending edits once a running sync is done; see `install`.
        std::thread::spawn(move || drop(session));
    }
    save_settings(&app, &AppSettings::default());
    Ok(())
}

#[tauri::command]
pub async fn set_remote(state: State<'_, AppState>, url: Option<String>) -> CmdResult<WorkspaceInfo> {
    let mut guard = state.session.lock().unwrap();
    let session = guard.as_mut().ok_or("No workspace is open")?;
    session.set_remote(url)?;
    Ok(session.info().clone())
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
    blocking(move || tree::list_pages(&Workspace::new(engine.root())).map_err(text)).await
}

#[tauri::command]
pub async fn read_page(state: State<'_, AppState>, id: String) -> CmdResult<Page> {
    let (engine, _) = state.engine()?;
    blocking(move || read_page_from(&Workspace::new(engine.root()), &id)).await
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
    blocking(move || {
        let write = engine.write_page_body(&id, &base, &body).map_err(text)?;
        edited();
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
    blocking(move || {
        let id = Workspace::new(engine.root())
            .create_page(&title, parent.as_deref())
            .map_err(text)?;
        edited();
        Ok(id)
    })
    .await
}

#[tauri::command]
pub async fn rename_page(state: State<'_, AppState>, id: String, title: String) -> CmdResult<()> {
    let (engine, edited) = state.engine()?;
    blocking(move || {
        Workspace::new(engine.root())
            .set_title(&id, &title)
            .map_err(text)?;
        edited();
        Ok(())
    })
    .await
}

/// Delete a page. Its child pages move to the top level.
#[tauri::command]
pub async fn delete_page(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let (engine, edited) = state.engine()?;
    blocking(move || {
        Workspace::new(engine.root()).delete_page(&id).map_err(text)?;
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
    blocking(move || {
        engine.resolve_page_conflict(&id, index, keep).map_err(text)?;
        edited();
        read_page_from(&Workspace::new(engine.root()), &id)
    })
    .await
}
