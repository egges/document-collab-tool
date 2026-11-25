//! Finding git: the one that ships with the app, or an installed one.

use std::path::PathBuf;

use std::sync::{Mutex, OnceLock};

use docsync::CliGit;
use docsync::git::GitCall;

use crate::devlog;

/// The git in use, e.g. "/opt/homebrew/bin/git 2.56.1", for the developer panel.
static DESCRIPTION: Mutex<Option<String>> = Mutex::new(None);

pub fn description() -> Option<String> {
    DESCRIPTION.lock().unwrap().clone()
}

/// Every git command goes to the developer log. Successful ones are debug
/// entries (a sync runs about ten); failures say why. Some failures are
/// normal, such as `rev-parse` on a branch that doesn't exist yet.
fn trace(call: &GitCall) {
    let command = format!("git {}", call.args.join(" "));
    let ms = call.duration.as_millis();
    match call.exit_code {
        Some(0) => devlog::debug("git", format!("{command} ({ms} ms)")),
        code => devlog::info(
            "git",
            format!(
                "{command} → exit {} ({ms} ms){}",
                code.map_or("?".to_string(), |c| c.to_string()),
                if call.stderr.is_empty() {
                    String::new()
                } else {
                    format!(": {}", devlog::short(&call.stderr, 400))
                }
            ),
        ),
    }
}

/// Where the app's own git lives (the `git` resource folder), set at start.
static BUNDLED_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn set_bundled_dir(dir: PathBuf) {
    let _ = BUNDLED_DIR.set(dir);
}

/// The git that ships with the app (see `scripts/fetch-git.mjs`), with the
/// environment a git needs when it isn't installed where it was built for.
/// `None` when this build has none, as in development before
/// `npm run fetch-git`.
fn bundled() -> Option<(PathBuf, CliGit)> {
    let dir = BUNDLED_DIR.get()?;
    if cfg!(windows) {
        let binary = dir.join("cmd").join("git.exe");
        if !binary.is_file() {
            return None;
        }
        // MinGit keeps its programs in a folder named after the toolchain.
        let sub = ["ucrt64", "clangarm64", "mingw64", "mingw32"]
            .iter()
            .map(|name| dir.join(name))
            .find(|path| path.is_dir())?;
        let mut path = std::ffi::OsString::new();
        path.push(sub.join("bin"));
        path.push(";");
        path.push(dir.join("usr").join("bin"));
        if let Some(inherited) = std::env::var_os("PATH") {
            path.push(";");
            path.push(inherited);
        }
        let git = CliGit::new(&binary)
            .with_env("GIT_EXEC_PATH", sub.join("libexec").join("git-core"))
            .with_env("PATH", path)
            // Use Windows' certificate store, as an installed Git for
            // Windows does, so company proxies and their certificates work.
            .with_config("http.sslBackend", "schannel");
        return Some((binary, git));
    }
    let binary = dir.join("bin").join("git");
    if !binary.is_file() {
        return None;
    }
    let mut git = CliGit::new(&binary)
        .with_env("GIT_EXEC_PATH", dir.join("libexec").join("git-core"))
        .with_env(
            "GIT_TEMPLATE_DIR",
            dir.join("share").join("git-core").join("templates"),
        );
    if cfg!(target_os = "linux") {
        git = git
            .with_env("PREFIX", dir)
            .with_env("GIT_SSL_CAINFO", dir.join("ssl").join("cacert.pem"));
    }
    Some((binary, git))
}

/// Places to look, in order: `DOCSYNC_GIT` (to try another git), the
/// app's own, then an installed one. An app started from the Finder or
/// Start menu doesn't get the shell's `PATH`, so common install locations
/// are listed too. macOS's own `/usr/bin/git` is usually older than docsync
/// needs.
fn candidates() -> Vec<(PathBuf, CliGit)> {
    let mut list = Vec::new();
    if let Some(path) = std::env::var_os("DOCSYNC_GIT").map(PathBuf::from) {
        list.push((path.clone(), CliGit::new(path)));
    }
    list.extend(bundled());
    let mut installed = vec![PathBuf::from("git")];
    if cfg!(target_os = "macos") {
        installed.extend(["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"].map(PathBuf::from));
    } else if cfg!(windows) {
        installed.push(PathBuf::from(r"C:\Program Files\Git\cmd\git.exe"));
    } else {
        installed.extend(["/usr/bin/git", "/usr/local/bin/git"].map(PathBuf::from));
    }
    list.extend(
        installed
            .into_iter()
            .map(|path| (path.clone(), CliGit::new(path))),
    );
    list
}

/// The app has no terminal, so git and ssh must never wait for input, and a
/// dead connection must fail instead of hanging a sync.
const NETWORK_CONFIG: &[(&str, &str)] = &[
    // Fail instead of asking for a password or to trust a new host key.
    ("core.sshCommand", "ssh -o BatchMode=yes -o ConnectTimeout=15"),
    // Give up on HTTPS transfers slower than 1 KB/s for 20 seconds.
    ("http.lowSpeedLimit", "1000"),
    ("http.lowSpeedTime", "20"),
];

/// The first git that is new enough for docsync.
pub fn find_git() -> Result<CliGit, String> {
    let mut problems = Vec::new();
    for (path, git) in candidates() {
        let git = NETWORK_CONFIG
            .iter()
            .fold(git, |git, (key, value)| git.with_config(*key, *value));
        match git.check_version() {
            Ok(version) => {
                let description = format!("{} {version}", path.display());
                devlog::info("app", format!("Using git: {description}"));
                *DESCRIPTION.lock().unwrap() = Some(description);
                return Ok(git
                    .with_config_source(crate::github::git_config)
                    .with_tracer(trace));
            }
            Err(e @ docsync::Error::UnsupportedGitVersion { .. }) => {
                problems.push(format!("{}: {e}", path.display()));
            }
            Err(_) => {} // not installed there
        }
    }
    let mut message =
        String::from("Git 2.43 or newer is needed. Install it, or set DOCSYNC_GIT to its path.");
    for problem in problems {
        message.push_str("\n- ");
        message.push_str(&problem);
    }
    devlog::error("app", &message);
    Err(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs when the bundled git has been fetched (`npm run fetch-git`, as
    /// CI does): it must start from where it is and do real work there.
    #[test]
    fn bundled_git_works_where_it_is() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("git");
        if !dir.join("bundled.json").is_file() {
            eprintln!("no bundled git; run `npm run fetch-git` to test it");
            return;
        }
        set_bundled_dir(dir.clone());
        let (binary, git) = bundled().expect("bundled git");
        assert!(binary.starts_with(&dir));
        git.check_version().unwrap();

        let repo = tempfile::tempdir().unwrap();
        docsync::git::GitBackend::init(&git, repo.path(), "main").unwrap();
        assert!(repo.path().join(".git").join("HEAD").is_file());
    }
}
