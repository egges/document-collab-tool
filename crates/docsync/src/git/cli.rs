use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use super::{
    BlobRef, CommitInfo, ConflictEntry, GitBackend, MergeTreeResult, Oid, PushResult, Signature, TextMerge,
    TreeEdit, TreeEntry,
};
use crate::error::IoContext;
use crate::{Error, Result};

/// `merge-file --object-id` needs 2.43; `merge-tree --write-tree` needs 2.38.
const MIN_VERSION: (u32, u32) = (2, 43);

#[cfg(windows)]
const NULL_DEVICE: &str = "NUL";
#[cfg(not(windows))]
const NULL_DEVICE: &str = "/dev/null";

/// Settings applied to every command, so behaviour does not depend on the
/// user's own git configuration.
const FIXED_CONFIG: &[(&str, &str)] = &[
    ("core.autocrlf", "false"),
    ("core.safecrlf", "false"),
    ("core.quotepath", "false"),
    ("core.hooksPath", NULL_DEVICE),
    ("merge.renames", "false"),
    ("merge.conflictStyle", "merge"),
    ("init.defaultBranch", "main"),
    ("user.name", "docsync"),
    ("user.email", "docsync@localhost"),
];

/// Environment variables that would redirect git to another repository,
/// index or configuration if inherited from the parent process.
const SCRUBBED_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_DATE",
];

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// [`GitBackend`] that runs a specific `git` executable, normally the one
/// bundled with the application.
///
/// The user's global and system git configuration is ignored. Use
/// [`CliGit::with_config`] for anything the app needs to add, such as an
/// authentication header; values are passed via the environment, not the
/// command line, so they do not show up in process listings.
#[derive(Debug, Clone)]
pub struct CliGit {
    binary: PathBuf,
    extra_config: Vec<(String, String)>,
    tracer: Option<Tracer>,
}

/// One git command, as reported to a [`CliGit::with_tracer`] callback.
#[derive(Debug, Clone)]
pub struct GitCall {
    pub args: Vec<String>,
    /// The exit code, or `None` when git couldn't be started or was killed.
    pub exit_code: Option<i32>,
    pub duration: std::time::Duration,
    /// What git wrote to stderr (trimmed). Never contains stdin or config
    /// values, so tokens passed through [`CliGit::with_config`] stay out.
    pub stderr: String,
}

type TraceFn = dyn Fn(&GitCall) + Send + Sync;

#[derive(Clone)]
struct Tracer(std::sync::Arc<TraceFn>);

impl std::fmt::Debug for Tracer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Tracer")
    }
}

impl CliGit {
    pub fn new(binary: impl Into<PathBuf>) -> Self {
        Self {
            binary: binary.into(),
            extra_config: Vec::new(),
            tracer: None,
        }
    }

    /// The `git` found on `PATH`. Meant for development and tests; the app
    /// should point [`CliGit::new`] at its bundled binary.
    pub fn from_path() -> Self {
        Self::new("git")
    }

    pub fn with_config(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.extra_config.push((key.into(), value.into()));
        self
    }

    /// Call `trace` after every git command, for a developer log.
    pub fn with_tracer(mut self, trace: impl Fn(&GitCall) + Send + Sync + 'static) -> Self {
        self.tracer = Some(Tracer(std::sync::Arc::new(trace)));
        self
    }

    pub fn binary(&self) -> &Path {
        &self.binary
    }

    /// Fail unless the binary is recent enough for the engine.
    pub fn check_version(&self) -> Result<String> {
        let version = self.version()?;
        match parse_version(&version) {
            Some(found) if found >= MIN_VERSION => Ok(version),
            _ => Err(Error::UnsupportedGitVersion {
                found: version,
                required: format!("{}.{}", MIN_VERSION.0, MIN_VERSION.1),
            }),
        }
    }

    fn command(&self, repo: Option<&Path>) -> Command {
        let mut cmd = Command::new(&self.binary);
        if let Some(repo) = repo {
            cmd.arg("-C").arg(repo);
        }
        for var in SCRUBBED_ENV {
            cmd.env_remove(var);
        }
        cmd.env("LC_ALL", "C")
            .env("LANGUAGE", "C")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", NULL_DEVICE);

        let config: Vec<(&str, &str)> = FIXED_CONFIG
            .iter()
            .copied()
            .chain(self.extra_config.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .collect();
        cmd.env("GIT_CONFIG_COUNT", config.len().to_string());
        for (i, (key, value)) in config.iter().enumerate() {
            cmd.env(format!("GIT_CONFIG_KEY_{i}"), key)
                .env(format!("GIT_CONFIG_VALUE_{i}"), value);
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    }

    /// Run a command and return its output whatever the exit status.
    fn exec(
        &self,
        repo: Option<&Path>,
        args: &[&str],
        stdin: Option<&[u8]>,
        env: &[(&str, &str)],
    ) -> Result<Output> {
        let Some(tracer) = &self.tracer else {
            return self.exec_untraced(repo, args, stdin, env);
        };
        let started = std::time::Instant::now();
        let result = self.exec_untraced(repo, args, stdin, env);
        let (exit_code, stderr) = match &result {
            Ok(out) => (out.status.code(), stderr_of(out)),
            Err(e) => (None, e.to_string()),
        };
        (tracer.0)(&GitCall {
            args: args.iter().map(|a| a.to_string()).collect(),
            exit_code,
            duration: started.elapsed(),
            stderr,
        });
        result
    }

    fn exec_untraced(
        &self,
        repo: Option<&Path>,
        args: &[&str],
        stdin: Option<&[u8]>,
        env: &[(&str, &str)],
    ) -> Result<Output> {
        let mut cmd = self.command(repo);
        cmd.args(args);
        for (key, value) in env {
            cmd.env(key, value);
        }
        if stdin.is_some() {
            cmd.stdin(Stdio::piped());
        }
        let mut child = cmd.spawn().at(&self.binary)?;
        if let Some(data) = stdin {
            let mut pipe = child.stdin.take().expect("stdin is piped");
            let data = data.to_vec();
            // Write from another thread so a full stdout pipe cannot deadlock us.
            let writer = std::thread::spawn(move || pipe.write_all(&data));
            let output = child.wait_with_output().at(&self.binary)?;
            writer
                .join()
                .map_err(|_| Error::Other("stdin writer panicked".into()))?
                .at(&self.binary)?;
            Ok(output)
        } else {
            child.wait_with_output().at(&self.binary)
        }
    }

    /// Run a command that must succeed and return its stdout.
    fn run(
        &self,
        repo: Option<&Path>,
        args: &[&str],
        stdin: Option<&[u8]>,
        env: &[(&str, &str)],
    ) -> Result<Vec<u8>> {
        let output = self.exec(repo, args, stdin, env)?;
        if output.status.success() {
            Ok(output.stdout)
        } else {
            Err(git_error(args, &output))
        }
    }

    fn run_str(&self, repo: &Path, args: &[&str]) -> Result<String> {
        let out = self.run(Some(repo), args, None, &[])?;
        Ok(String::from_utf8_lossy(&out).trim().to_string())
    }
}

fn git_error(args: &[&str], output: &Output) -> Error {
    Error::Git {
        command: args.join(" "),
        status: output.status.code(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    }
}

fn stderr_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

fn path_str(path: &Path) -> Result<&str> {
    path.to_str()
        .ok_or_else(|| Error::InvalidState(format!("path is not UTF-8: {}", path.display())))
}

pub(crate) fn parse_version(version: &str) -> Option<(u32, u32)> {
    let token = version
        .split_whitespace()
        .find(|t| t.starts_with(|c: char| c.is_ascii_digit()))?;
    let mut parts = token.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

/// Split NUL-terminated output into UTF-8 records.
fn nul_records(out: &[u8]) -> impl Iterator<Item = String> + '_ {
    out.split(|b| *b == 0)
        .filter(|r| !r.is_empty())
        .map(|r| String::from_utf8_lossy(r).into_owned())
}

fn is_within(path: &str, prefix: &str) -> bool {
    path == prefix || (path.starts_with(prefix) && path.as_bytes().get(prefix.len()) == Some(&b'/'))
}

impl GitBackend for CliGit {
    fn version(&self) -> Result<String> {
        let out = self.run(None, &["--version"], None, &[])?;
        let text = String::from_utf8_lossy(&out);
        Ok(text.trim().trim_start_matches("git version ").to_string())
    }

    fn init(&self, dir: &Path, branch: &str) -> Result<()> {
        self.run(None, &["init", "-q", "-b", branch, path_str(dir)?], None, &[])?;
        Ok(())
    }

    fn set_remote_url(&self, repo: &Path, remote: &str, url: &str) -> Result<()> {
        let existing = self.exec(Some(repo), &["remote", "get-url", remote], None, &[])?;
        let action = if existing.status.success() {
            "set-url"
        } else {
            "add"
        };
        self.run(Some(repo), &["remote", action, remote, url], None, &[])?;
        Ok(())
    }

    fn head_ref(&self, repo: &Path) -> Result<Option<String>> {
        let args = ["symbolic-ref", "-q", "HEAD"];
        let out = self.exec(Some(repo), &args, None, &[])?;
        match out.status.code() {
            Some(0) => Ok(Some(String::from_utf8_lossy(&out.stdout).trim().to_string())),
            Some(1) => Ok(None),
            _ => Err(git_error(&args, &out)),
        }
    }

    fn resolve(&self, repo: &Path, rev: &str) -> Result<Option<Oid>> {
        let out = self.exec(
            Some(repo),
            &["rev-parse", "--verify", "-q", "--end-of-options", rev],
            None,
            &[],
        )?;
        if out.status.success() {
            Ok(Some(Oid::new(String::from_utf8_lossy(&out.stdout).trim())))
        } else {
            Ok(None)
        }
    }

    fn stage_all(&self, repo: &Path) -> Result<()> {
        self.run(Some(repo), &["add", "-A"], None, &[])?;
        Ok(())
    }

    fn write_index_tree(&self, repo: &Path) -> Result<Oid> {
        Ok(Oid::new(self.run_str(repo, &["write-tree"])?))
    }

    fn commit_tree(
        &self,
        repo: &Path,
        tree: &Oid,
        parents: &[Oid],
        message: &str,
        author: &Signature,
    ) -> Result<Oid> {
        let mut args = vec!["commit-tree", tree.as_str()];
        for parent in parents {
            args.push("-p");
            args.push(parent.as_str());
        }
        let date = format!("@{} +0000", author.time);
        let env = [
            ("GIT_AUTHOR_NAME", author.name.as_str()),
            ("GIT_AUTHOR_EMAIL", author.email.as_str()),
            ("GIT_AUTHOR_DATE", date.as_str()),
            ("GIT_COMMITTER_NAME", author.name.as_str()),
            ("GIT_COMMITTER_EMAIL", author.email.as_str()),
            ("GIT_COMMITTER_DATE", date.as_str()),
        ];
        let out = self.run(Some(repo), &args, Some(message.as_bytes()), &env)?;
        Ok(Oid::new(String::from_utf8_lossy(&out).trim()))
    }

    fn update_ref(&self, repo: &Path, refname: &str, new: &Oid, expected_old: Option<&Oid>) -> Result<()> {
        let mut args = vec!["update-ref", "-m", "docsync", refname, new.as_str()];
        if let Some(old) = expected_old {
            args.push(old.as_str());
        }
        self.run(Some(repo), &args, None, &[])?;
        Ok(())
    }

    fn checkout(&self, repo: &Path, from: &Oid, to: &Oid) -> Result<()> {
        // Refresh stat information so unchanged files are not reported dirty.
        self.exec(Some(repo), &["update-index", "-q", "--refresh"], None, &[])?;
        let args = ["read-tree", "-m", "-u", from.as_str(), to.as_str()];
        let out = self.exec(Some(repo), &args, None, &[])?;
        if out.status.success() {
            return Ok(());
        }
        let stderr = stderr_of(&out);
        if stderr.contains("not uptodate")
            || stderr.contains("would be overwritten")
            || stderr.contains("would be lost")
        {
            Err(Error::WorkingTreeChanged(stderr))
        } else {
            Err(git_error(&args, &out))
        }
    }

    fn fetch(&self, repo: &Path, remote: &str, branch: &str) -> Result<Option<Oid>> {
        let tracking = format!("refs/remotes/{remote}/{branch}");
        let refspec = format!("+refs/heads/{branch}:{tracking}");
        let out = self.exec(
            Some(repo),
            &[
                "fetch",
                "-q",
                "--no-tags",
                "--no-recurse-submodules",
                remote,
                &refspec,
            ],
            None,
            &[],
        )?;
        if out.status.success() {
            return self.resolve(repo, &tracking);
        }
        let stderr = stderr_of(&out);
        if stderr.contains("couldn't find remote ref") {
            Ok(None)
        } else {
            Err(Error::Network(stderr))
        }
    }

    fn push(&self, repo: &Path, remote: &str, commit: &Oid, branch: &str) -> Result<PushResult> {
        let target = format!("refs/heads/{branch}");
        let refspec = format!("{commit}:{target}");
        let out = self.exec(
            Some(repo),
            &["push", "--porcelain", "--no-verify", remote, &refspec],
            None,
            &[],
        )?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        // Porcelain lines look like "<flag>\t<from>:<to>\t<summary>".
        for line in stdout.lines() {
            let fields: Vec<&str> = line.split('\t').collect();
            if fields.len() >= 3 && fields[1].ends_with(&format!(":{target}")) {
                return Ok(if fields[0] == "!" {
                    PushResult::Rejected(fields[2..].join(" "))
                } else {
                    PushResult::Pushed
                });
            }
        }
        if out.status.success() {
            Ok(PushResult::Pushed)
        } else {
            Err(Error::Network(stderr_of(&out)))
        }
    }

    fn is_ancestor(&self, repo: &Path, ancestor: &Oid, descendant: &Oid) -> Result<bool> {
        let args = [
            "merge-base",
            "--is-ancestor",
            ancestor.as_str(),
            descendant.as_str(),
        ];
        let out = self.exec(Some(repo), &args, None, &[])?;
        match out.status.code() {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            _ => Err(git_error(&args, &out)),
        }
    }

    fn merge_base(&self, repo: &Path, a: &Oid, b: &Oid) -> Result<Option<Oid>> {
        let args = ["merge-base", a.as_str(), b.as_str()];
        let out = self.exec(Some(repo), &args, None, &[])?;
        match out.status.code() {
            Some(0) => Ok(Some(Oid::new(String::from_utf8_lossy(&out.stdout).trim()))),
            Some(1) => Ok(None),
            _ => Err(git_error(&args, &out)),
        }
    }

    fn merge_trees(&self, repo: &Path, ours: &Oid, theirs: &Oid) -> Result<MergeTreeResult> {
        let args = [
            "merge-tree",
            "--write-tree",
            "-z",
            "--no-messages",
            "--allow-unrelated-histories",
            ours.as_str(),
            theirs.as_str(),
        ];
        let out = self.exec(Some(repo), &args, None, &[])?;
        if !matches!(out.status.code(), Some(0) | Some(1)) {
            return Err(git_error(&args, &out));
        }
        let mut records = nul_records(&out.stdout);
        let tree = Oid::new(records.next().ok_or_else(|| git_error(&args, &out))?);
        let mut conflicts: BTreeMap<String, ConflictEntry> = BTreeMap::new();
        for record in records {
            // "<mode> <oid> <stage>\t<path>"
            let (meta, path) = record
                .split_once('\t')
                .ok_or_else(|| Error::Other(format!("unexpected merge-tree output: {record}")))?;
            let mut meta = meta.split(' ');
            let (Some(mode), Some(oid), Some(stage)) = (meta.next(), meta.next(), meta.next()) else {
                return Err(Error::Other(format!("unexpected merge-tree output: {record}")));
            };
            let blob = Some(BlobRef {
                mode: mode.to_string(),
                oid: Oid::new(oid),
            });
            let entry = conflicts
                .entry(path.to_string())
                .or_insert_with(|| ConflictEntry {
                    path: path.to_string(),
                    base: None,
                    ours: None,
                    theirs: None,
                });
            match stage {
                "1" => entry.base = blob,
                "2" => entry.ours = blob,
                "3" => entry.theirs = blob,
                other => return Err(Error::Other(format!("unexpected merge stage {other}"))),
            }
        }
        Ok(MergeTreeResult {
            tree,
            conflicts: conflicts.into_values().collect(),
        })
    }

    fn merge_text(
        &self,
        repo: &Path,
        base: &Oid,
        ours: &Oid,
        theirs: &Oid,
        labels: [&str; 3],
        marker_size: usize,
    ) -> Result<TextMerge> {
        let marker = format!("--marker-size={marker_size}");
        let args = [
            "merge-file",
            "-p",
            "--object-id",
            &marker,
            "-L",
            labels[0],
            "-L",
            labels[1],
            "-L",
            labels[2],
            ours.as_str(),
            base.as_str(),
            theirs.as_str(),
        ];
        let out = self.exec(Some(repo), &args, None, &[])?;
        // Exit code is the number of conflicts; >127 signals an error.
        match out.status.code() {
            Some(code @ 0..=127) => Ok(TextMerge {
                content: out.stdout,
                conflicts: code as u32,
            }),
            _ => Err(git_error(&args, &out)),
        }
    }

    fn read_blob(&self, repo: &Path, oid: &Oid) -> Result<Vec<u8>> {
        self.run(Some(repo), &["cat-file", "blob", oid.as_str()], None, &[])
    }

    fn write_blob(&self, repo: &Path, data: &[u8]) -> Result<Oid> {
        let out = self.run(
            Some(repo),
            &["hash-object", "-w", "--no-filters", "--stdin"],
            Some(data),
            &[],
        )?;
        Ok(Oid::new(String::from_utf8_lossy(&out).trim()))
    }

    fn list_tree(&self, repo: &Path, treeish: &Oid, prefix: Option<&str>) -> Result<Vec<TreeEntry>> {
        let mut args = vec!["ls-tree", "-r", "-z", "--full-tree", treeish.as_str()];
        if let Some(prefix) = prefix {
            args.push("--");
            args.push(prefix);
        }
        let out = self.run(Some(repo), &args, None, &[])?;
        let mut entries = Vec::new();
        for record in nul_records(&out) {
            // "<mode> <type> <oid>\t<path>"
            let Some((meta, path)) = record.split_once('\t') else {
                continue;
            };
            let fields: Vec<&str> = meta.split(' ').collect();
            if fields.len() != 3 || fields[1] != "blob" {
                continue;
            }
            if prefix.is_some_and(|prefix| !is_within(path, prefix)) {
                continue;
            }
            entries.push(TreeEntry {
                mode: fields[0].to_string(),
                oid: Oid::new(fields[2]),
                path: path.to_string(),
            });
        }
        Ok(entries)
    }

    fn changed_paths(&self, repo: &Path, from: &Oid, to: &Oid) -> Result<Vec<String>> {
        let out = self.run(
            Some(repo),
            &[
                "diff-tree",
                "-r",
                "-z",
                "--name-only",
                "--no-renames",
                "--no-commit-id",
                from.as_str(),
                to.as_str(),
            ],
            None,
            &[],
        )?;
        Ok(nul_records(&out).collect())
    }

    fn edit_tree(&self, repo: &Path, base: &Oid, edits: &[TreeEdit]) -> Result<Oid> {
        let index = repo.join(".git").join(format!(
            "docsync-index-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let index_str = path_str(&index)?.to_string();
        let env = [("GIT_INDEX_FILE", index_str.as_str())];
        let zero = "0".repeat(base.as_str().len());

        let mut input = Vec::new();
        for edit in edits {
            match edit {
                TreeEdit::Upsert { path, mode, oid } => {
                    input.extend_from_slice(format!("{mode} {oid}\t{path}").as_bytes())
                }
                TreeEdit::Remove { path } => input.extend_from_slice(format!("0 {zero}\t{path}").as_bytes()),
            }
            input.push(0);
        }

        let result = (|| {
            self.run(Some(repo), &["read-tree", base.as_str()], None, &env)?;
            self.run(
                Some(repo),
                &["update-index", "-z", "--index-info"],
                Some(&input),
                &env,
            )?;
            let out = self.run(Some(repo), &["write-tree"], None, &env)?;
            Ok(Oid::new(String::from_utf8_lossy(&out).trim()))
        })();
        let _ = std::fs::remove_file(&index);
        result
    }

    fn path_history(
        &self,
        repo: &Path,
        since: Option<&Oid>,
        until: &Oid,
        path: &str,
    ) -> Result<Vec<CommitInfo>> {
        let range = match since {
            Some(since) => format!("{since}..{until}"),
            None => until.to_string(),
        };
        let out = self.run(
            Some(repo),
            &["log", "--no-merges", "--format=%H %ct %an", &range, "--", path],
            None,
            &[],
        )?;
        let text = String::from_utf8_lossy(&out);
        Ok(text
            .lines()
            .filter_map(|line| {
                let mut parts = line.splitn(3, ' ');
                let oid = parts.next()?;
                let time = parts.next()?.parse().ok()?;
                Some(CommitInfo {
                    oid: Oid::new(oid),
                    time,
                    author: parts.next().unwrap_or("").to_string(),
                })
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_every_command_to_the_tracer() {
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = calls.clone();
        let git = CliGit::from_path().with_tracer(move |call| seen.lock().unwrap().push(call.clone()));
        git.version().unwrap();
        let dir = std::env::temp_dir();
        // Fails inside git (no such directory); resolve() reports that as "not found".
        assert_eq!(
            git.resolve(&dir.join("not-a-repo-docsync-test"), "HEAD").unwrap(),
            None
        );

        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].args, ["--version"]);
        assert_eq!(calls[0].exit_code, Some(0));
        assert!(
            calls[1].exit_code != Some(0) && !calls[1].stderr.is_empty(),
            "{:?}",
            calls[1]
        );
    }

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("2.56.1"), Some((2, 56)));
        assert_eq!(parse_version("2.39.5 (Apple Git-154)"), Some((2, 39)));
        assert_eq!(parse_version("2.45.2.windows.1"), Some((2, 45)));
        assert_eq!(parse_version("garbage"), None);
    }

    #[test]
    fn prefix_matching_respects_path_components() {
        assert!(is_within("pages/abc/meta.json", "pages/abc"));
        assert!(is_within("pages/abc", "pages/abc"));
        assert!(!is_within("pages/abcd/meta.json", "pages/abc"));
    }
}
