//! How a workspace is laid out on disk.
//!
//! ```text
//! workspace.json                      workspace settings: {"format", "name", "kept_in"}
//! pages/<page-id>/meta.json           title, parent, properties (+ their types), display, database
//! pages/<page-id>/page.md             page body
//! pages/<page-id>/assets/...          attachments
//! databases/<db-id>/schema.json       name, columns
//! databases/<db-id>/rows/<row>.json   one file per row: its cells (its properties)
//! databases/<db-id>/rows/<row>.md     the row's text: every row is a page too
//! ```
//!
//! Paths are derived from stable random ids, never from titles, so renaming
//! or moving a page only edits a JSON field. Each page and database is an
//! *entity*: a directory that is created, deleted and restored as a whole.

pub const PAGES_DIR: &str = "pages";
pub const DATABASES_DIR: &str = "databases";
pub const WORKSPACE_FILE: &str = "workspace.json";
pub const PAGE_META: &str = "meta.json";
pub const PAGE_BODY: &str = "page.md";
pub const PAGE_ASSETS: &str = "assets";
pub const DATABASE_SCHEMA: &str = "schema.json";
pub const DATABASE_ROWS: &str = "rows";

/// Suffix for temporary files written before an atomic rename.
pub const TEMP_SUFFIX: &str = ".docsync-tmp";

/// Marker in the name of a file that holds the losing side of a conflict.
pub const CONFLICT_COPY_MARKER: &str = ".conflict-";

pub const GITIGNORE: &str = "\
# Per-device state (search index, caches). Never synced.
.docsync/
*.docsync-tmp
.DS_Store
";

/// How a file is merged when both sides changed it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    /// Line-based merge; overlapping edits become a conflict block.
    Markdown,
    /// Field-by-field merge; clashing fields go to the most recent edit.
    Json,
    /// Opaque; the most recent version wins and the other is kept as a copy.
    Other,
}

pub fn file_kind(path: &str) -> FileKind {
    let name = path.rsplit('/').next().unwrap_or(path);
    if name.ends_with(".md") {
        FileKind::Markdown
    } else if name.ends_with(".json") {
        FileKind::Json
    } else {
        FileKind::Other
    }
}

/// The page or database directory a path belongs to, if any.
pub fn dir_entity(path: &str) -> Option<&str> {
    let mut parts = path.splitn(3, '/');
    let top = parts.next()?;
    let id = parts.next()?;
    parts.next()?; // must be a file inside the entity directory
    if (top == PAGES_DIR || top == DATABASES_DIR) && !id.is_empty() {
        Some(&path[..top.len() + 1 + id.len()])
    } else {
        None
    }
}

/// Whether `path` is `dir` itself or lies inside it.
pub fn is_within(path: &str, dir: &str) -> bool {
    path == dir || (path.starts_with(dir) && path.as_bytes().get(dir.len()) == Some(&b'/'))
}

/// Path for the losing side of a conflict on an opaque file:
/// `img.png` becomes `img.conflict-<label>-<id>.png`.
pub fn conflict_copy_path(path: &str, label: &str, id: &str) -> String {
    let (dir, name) = match path.rfind('/') {
        Some(i) => (&path[..=i], &path[i + 1..]),
        None => ("", path),
    };
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    format!("{dir}{stem}{CONFLICT_COPY_MARKER}{}-{id}{ext}", slug(label))
}

/// Lowercase ASCII letters, digits and dashes.
pub fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() { "device".into() } else { out }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_files() {
        assert_eq!(file_kind("pages/a/page.md"), FileKind::Markdown);
        assert_eq!(file_kind("pages/a/meta.json"), FileKind::Json);
        assert_eq!(file_kind("pages/a/assets/x.png"), FileKind::Other);
    }

    #[test]
    fn finds_entities() {
        assert_eq!(dir_entity("pages/abc/meta.json"), Some("pages/abc"));
        assert_eq!(dir_entity("pages/abc/assets/x.png"), Some("pages/abc"));
        assert_eq!(dir_entity("databases/d1/rows/r1.json"), Some("databases/d1"));
        assert_eq!(dir_entity("pages/abc"), None);
        assert_eq!(dir_entity("workspace.json"), None);
        assert_eq!(dir_entity("other/abc/x"), None);
    }

    #[test]
    fn names_conflict_copies() {
        assert_eq!(
            conflict_copy_path("pages/a/assets/img.png", "Arjan's MacBook", "abc123"),
            "pages/a/assets/img.conflict-arjan-s-macbook-abc123.png"
        );
        assert_eq!(conflict_copy_path("LICENSE", "x", "1"), "LICENSE.conflict-x-1");
    }
}
