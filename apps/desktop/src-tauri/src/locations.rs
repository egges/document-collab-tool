//! Where workspaces live when the user doesn't pick a folder.
//!
//! The default is the app's local data folder (`~/Library/Application
//! Support/<app>/workspaces` on macOS, `%LOCALAPPDATA%\<app>\workspaces` on
//! Windows, `~/.local/share/<app>/workspaces` on Linux). Unlike `~/Documents`,
//! that folder is never synced by iCloud or OneDrive (a working copy with
//! `.git` inside a cloud folder breaks), and opening it never triggers a
//! macOS permission prompt. "Show in Finder" makes the files easy to reach.

use std::path::{Path, PathBuf};

/// The name used when the user leaves it empty.
pub const DEFAULT_NAME: &str = "My Notes";

/// `name` as a folder name that works on every platform. The folder name is
/// also the workspace's name in the sidebar, so keep it readable.
pub fn folder_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    // No hidden folders, and Windows drops trailing dots.
    let cleaned = cleaned
        .trim_start_matches('.')
        .trim_end_matches(['.', ' '])
        .trim();
    let cleaned: String = cleaned.chars().take(80).collect();
    let cleaned = cleaned.trim_end_matches(['.', ' ']);
    let reserved = {
        let stem = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
        matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.as_bytes()[3].is_ascii_digit())
    };
    if cleaned.is_empty() || reserved {
        DEFAULT_NAME.to_string()
    } else {
        cleaned.to_string()
    }
}

/// A folder in `base` for a new workspace called `name` that doesn't exist
/// yet: "My Notes", then "My Notes 2", "My Notes 3", and so on.
pub fn new_workspace_dir(base: &Path, name: &str) -> PathBuf {
    let name = folder_name(name);
    let mut candidate = base.join(&name);
    let mut n = 2;
    while candidate.exists() {
        candidate = base.join(format!("{name} {n}"));
        n += 1;
    }
    candidate
}

/// A name for a workspace joined from `url`: the repository's name, e.g.
/// "notes" for `git@github.com:you/notes.git` or `/Volumes/USB/notes.git`.
pub fn name_from_url(url: &str) -> String {
    let last = url
        .trim()
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\', ':'])
        .next()
        .unwrap_or("");
    let last = last.strip_suffix(".git").unwrap_or(last);
    let last = last.strip_suffix(".docsync").unwrap_or(last);
    let last = last.strip_suffix(".docsync").unwrap_or(last);
    folder_name(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_names_are_safe_everywhere() {
        assert_eq!(folder_name("Team Notes"), "Team Notes");
        assert_eq!(folder_name("  Q3: plans/ideas?  "), "Q3 plans ideas");
        assert_eq!(folder_name("..hidden"), "hidden");
        assert_eq!(folder_name("Notes..."), "Notes");
        assert_eq!(folder_name(""), DEFAULT_NAME);
        assert_eq!(folder_name("///"), DEFAULT_NAME);
        assert_eq!(folder_name("con"), DEFAULT_NAME);
        assert_eq!(folder_name("COM1.txt"), DEFAULT_NAME);
        assert_eq!(folder_name("Console"), "Console");
        assert_eq!(folder_name("Café ☕"), "Café ☕");
        assert_eq!(folder_name(&"x".repeat(200)).chars().count(), 80);
    }

    #[test]
    fn new_folders_never_reuse_an_existing_one() {
        let dir = tempfile::tempdir().unwrap();
        let first = new_workspace_dir(dir.path(), "Notes");
        assert_eq!(first, dir.path().join("Notes"));
        std::fs::create_dir(&first).unwrap();
        assert_eq!(new_workspace_dir(dir.path(), "Notes"), dir.path().join("Notes 2"));
        std::fs::create_dir(dir.path().join("Notes 2")).unwrap();
        assert_eq!(new_workspace_dir(dir.path(), "Notes"), dir.path().join("Notes 3"));
        // The base folder doesn't need to exist yet.
        let missing = dir.path().join("workspaces");
        assert_eq!(new_workspace_dir(&missing, ""), missing.join(DEFAULT_NAME));
    }

    #[test]
    fn names_come_from_the_repository() {
        assert_eq!(name_from_url("git@github.com:you/notes.git"), "notes");
        assert_eq!(
            name_from_url("https://github.com/you/Team-Notes.git/"),
            "Team-Notes"
        );
        assert_eq!(name_from_url("/Users/me/Dropbox/My Notes.docsync"), "My Notes");
        assert_eq!(name_from_url(r"C:\Shared\notes.git"), "notes");
        assert_eq!(name_from_url("git@host:repo"), "repo");
        assert_eq!(name_from_url(""), DEFAULT_NAME);
    }
}
