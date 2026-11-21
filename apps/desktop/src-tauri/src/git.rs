//! Finding a git binary until the app bundles its own (roadmap step 3).

use std::path::PathBuf;

use std::sync::Mutex;

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
            Ok(version) => {
                let description = format!("{} {version}", path.display());
                devlog::info("app", format!("Using git: {description}"));
                *DESCRIPTION.lock().unwrap() = Some(description);
                return Ok(git.with_tracer(trace));
            }
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
    devlog::error("app", &message);
    Err(message)
}
