//! Finding a git binary until the app bundles its own (roadmap step 3).

use std::path::PathBuf;

use docsync::CliGit;

/// Places to look, in order. An app started from the Finder or Start menu
/// doesn't get the shell's `PATH`, so common install locations are listed
/// too. macOS's own `/usr/bin/git` is usually older than docsync needs.
fn candidates() -> Vec<PathBuf> {
    let mut list = Vec::new();
    if let Some(path) = std::env::var_os("DOCSYNC_GIT") {
        list.push(PathBuf::from(path));
    }
    list.push(PathBuf::from("git"));
    if cfg!(target_os = "macos") {
        list.extend(["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"].map(PathBuf::from));
    } else if cfg!(windows) {
        list.push(PathBuf::from(r"C:\Program Files\Git\cmd\git.exe"));
    } else {
        list.extend(["/usr/bin/git", "/usr/local/bin/git"].map(PathBuf::from));
    }
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
    for path in candidates() {
        let git = NETWORK_CONFIG
            .iter()
            .fold(CliGit::new(&path), |git, (key, value)| {
                git.with_config(*key, *value)
            });
        match git.check_version() {
            Ok(_) => return Ok(git),
            Err(e @ docsync::Error::UnsupportedGitVersion { .. }) => {
                problems.push(format!("{}: {e}", path.display()));
            }
            Err(_) => {} // not installed there
        }
    }
    let mut message = String::from(
        "Git 2.43 or newer is needed. Install it, or set DOCSYNC_GIT to its path. \
         (Later versions of the app include Git.)",
    );
    for problem in problems {
        message.push_str("\n- ");
        message.push_str(&problem);
    }
    Err(message)
}
