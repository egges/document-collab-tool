//! The desktop app's Rust side: opens a workspace with docsync, decides
//! when to commit and sync, and answers the window's commands.

mod commands;
mod git;
mod session;
mod tree;
mod worker;

use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::AppState::default())
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(true) = event {
                window.state::<commands::AppState>().window_focused();
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
            commands::write_page,
            commands::create_page,
            commands::rename_page,
            commands::delete_page,
            commands::resolve_conflict,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
