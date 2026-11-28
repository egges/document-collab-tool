//! Images and other attachments in a page's `assets/` folder: saving the
//! ones pasted or dropped into the editor, and the `page-asset:` protocol
//! the editor loads them through.

use std::path::{Component, Path};

use percent_encoding::percent_decode_str;
use tauri::http::{Request, Response, StatusCode, header::CONTENT_TYPE};
use tauri::ipc::InvokeBody;
use tauri::{AppHandle, Manager, State, UriSchemeContext, UriSchemeResponder};

use crate::commands::{AppState, CmdResult, blocking, text};
use crate::devlog;

/// The protocol's name. The window asks for
/// `page-asset://localhost/<page-id>%2Fassets%2F<file>` (via `convertFileSrc`).
pub const PROTOCOL: &str = "page-asset";

/// Save a file pasted or dropped into page `page` (header) as `name`
/// (header, URI-encoded); the body is the file's bytes. Returns the link
/// to it for the page's text, `assets/<name>`.
#[tauri::command]
pub async fn add_page_asset(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> CmdResult<String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the file's bytes".into());
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|v| percent_decode_str(v).decode_utf8_lossy().into_owned())
            .ok_or_else(|| format!("Missing the {name} header"))
    };
    let (page, name, bytes) = (header("page")?, header("name")?, bytes.clone());
    let (engine, edited) = state.engine()?;
    blocking("add_page_asset", move || {
        let link = engine.add_page_asset(&page, &name, &bytes).map_err(text)?;
        devlog::info(
            "save",
            format!("Added {link} ({} bytes) to page {page}", bytes.len()),
        );
        edited();
        Ok(link)
    })
    .await
}

/// Answers `page-asset:` requests with the file from the open workspace's
/// `pages/` folder, and nothing outside it.
pub fn serve(
    ctx: UriSchemeContext<'_, tauri::Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app: AppHandle = ctx.app_handle().clone();
    let path = request.uri().path().trim_start_matches('/').to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let response = match read(&app, &path) {
            Some(bytes) => Response::builder()
                .header(CONTENT_TYPE, content_type(&path))
                .body(bytes),
            None => Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()),
        };
        responder.respond(response.expect("valid response"));
    });
}

fn read(app: &AppHandle, path: &str) -> Option<Vec<u8>> {
    let rel = percent_decode_str(path).decode_utf8().ok()?;
    let rel = Path::new(rel.as_ref());
    if !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return None;
    }
    let (engine, _) = app.state::<AppState>().engine().ok()?;
    let pages = engine
        .root()
        .join(docsync::layout::PAGES_DIR)
        .canonicalize()
        .ok()?;
    // Canonical, so a symlink can't lead out of the workspace either.
    let file = pages.join(rel).canonicalize().ok()?;
    if !file.starts_with(&pages) {
        return None;
    }
    std::fs::read(&file).ok()
}

fn content_type(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_types_follow_the_extension() {
        assert_eq!(content_type("a%2Fassets%2Fphoto.JPG"), "image/jpeg");
        assert_eq!(content_type("a%2Fassets%2Fnotes"), "application/octet-stream");
    }
}
