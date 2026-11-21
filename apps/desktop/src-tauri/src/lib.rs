//! The desktop app's Rust side: opens a workspace with docsync, decides
//! when to commit and sync, and answers the window's commands.

mod commands;
mod devlog;
mod git;
mod search;
mod session;
mod tree;
mod worker;

use tauri::{Emitter, Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(commands::AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            devlog::set_sink(move |entry| {
                let _ = handle.emit("dev-log", entry);
            });
            devlog::info("app", format!("Started version {}", app.package_info().version));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(focused) = event {
                devlog::debug(
                    "app",
                    if *focused {
                        "Window focused"
                    } else {
                        "Window lost focus"
                    },
                );
                if *focused {
                    window.state::<commands::AppState>().window_focused();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::restore_workspace,
            commands::open_workspace,
            commands::clone_workspace,
            commands::close_workspace,
            commands::set_remote,
            commands::sync_status,
            commands::sync_now,
            commands::list_pages,
            commands::read_page,
            commands::search_text,
            commands::write_page,
            commands::create_page,
            commands::rename_page,
            commands::delete_page,
            commands::resolve_conflict,
            commands::dev_info,
            commands::dev_log_entries,
            commands::dev_log_clear,
            commands::dev_log_add,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
