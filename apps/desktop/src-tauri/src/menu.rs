//! The app's menu bar. Tauri's default menu, except that on macOS the app
//! menu's items say the product name ("About Sawmill", "Quit Sawmill").
//! Left to themselves they take the running process's name, which is the
//! Cargo binary's when the app runs unbundled with `tauri dev`. The About
//! panel also shows the app icon, which an unbundled app doesn't have.

use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    #[cfg(target_os = "macos")]
    {
        let name = app.package_info().name.clone();
        let about = AboutMetadata {
            name: Some(name.clone()),
            version: Some(app.package_info().version.to_string()),
            copyright: app.config().bundle.copyright.clone(),
            icon: app.default_window_icon().cloned(),
            ..Default::default()
        };
        let app_menu = Submenu::with_items(
            app,
            &name,
            true,
            &[
                &PredefinedMenuItem::about(app, Some(&format!("About {name}")), Some(about))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::services(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, Some(&format!("Hide {name}")))?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, Some(&format!("Quit {name}")))?,
            ],
        )?;
        // The default menu's first submenu is the app menu: swap it.
        menu.remove_at(0)?;
        menu.insert(&app_menu, 0)?;
    }
    Ok(menu)
}
