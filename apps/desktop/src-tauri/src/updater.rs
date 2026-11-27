//! Automatic updates, for release builds (`tauri.release.conf.json` sets
//! the updater's endpoint and public key; development builds have neither
//! and never update).
//!
//! Quiet by design: the app checks shortly after it starts and then every
//! few hours, downloads and installs a newer version in the background,
//! and the new version runs from the next start. Meanwhile the window shows
//! a small "Restart to update". Failures only go to the log.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_updater::UpdaterExt;

use crate::devlog;

/// The first check waits until the app has settled.
const FIRST_CHECK: Duration = Duration::from_secs(20);
const CHECK_EVERY: Duration = Duration::from_secs(4 * 60 * 60);

/// The version installed and waiting for a restart, if any.
#[derive(Default)]
pub struct UpdateState {
    ready: Mutex<Option<String>>,
}

/// Whether this build has an updater configured.
pub fn configured(config: &tauri::Config) -> bool {
    config.plugins.0.contains_key("updater")
}

/// Check now and then for as long as the app runs, on a thread of its own.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK);
        loop {
            tauri::async_runtime::block_on(check_and_install(&app));
            if app.state::<UpdateState>().ready.lock().unwrap().is_some() {
                break; // installed; nothing more to do until a restart
            }
            std::thread::sleep(CHECK_EVERY);
        }
    });
}

async fn check_and_install<R: Runtime>(app: &AppHandle<R>) {
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(e) => return devlog::warn("update", format!("Updater unavailable: {e}")),
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return devlog::debug("update", "No newer version"),
        Err(e) => return devlog::warn("update", format!("Checking for updates failed: {e}")),
    };
    let version = update.version.clone();
    devlog::info("update", format!("Downloading version {version}"));
    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(()) => {
            devlog::info(
                "update",
                format!("Installed version {version}; it runs from the next start"),
            );
            *app.state::<UpdateState>().ready.lock().unwrap() = Some(version.clone());
            let _ = app.emit("update-ready", version);
        }
        Err(e) => devlog::warn("update", format!("Installing version {version} failed: {e}")),
    }
}

/// The version installed and waiting for a restart.
#[tauri::command]
pub fn update_ready(state: tauri::State<'_, UpdateState>) -> Option<String> {
    state.ready.lock().unwrap().clone()
}

/// Restart into the installed update. Pending edits are on disk already
/// (the window saves before calling this), and the sync worker commits
/// them on the next start.
#[tauri::command]
pub fn restart_to_update<R: Runtime>(app: AppHandle<R>) {
    devlog::info("update", "Restarting to update");
    app.restart();
}
