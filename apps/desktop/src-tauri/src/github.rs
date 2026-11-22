//! Signing in with GitHub, through the "Pagemesh Desktop" GitHub App.
//!
//! The app signs in through the browser: GitHub's sign-in page with PKCE,
//! sending the user back to a listener on 127.0.0.1 (no click at all for
//! someone who has signed in before), then its install page if the App
//! isn't installed yet. That needs the
//! App's client secret, built in from a gitignored file (see build.rs); a
//! build without it signs in with the device flow instead (a code the user
//! enters at github.com/login/device). The App can only reach repositories
//! the user installed it on, unlike an OAuth app's `repo` scope, which
//! reaches every private repo.
//!
//! The access token lasts 8 hours and is renewed in the background with the
//! refresh token (good for 6 months). Both live in the system keychain,
//! never in a file, except in debug builds (see [`init`]). Git gets the token in an `http.<url>.extraHeader`
//! setting, through the environment, so it stays out of `.git/config`,
//! remote URLs and process listings.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::devlog;
use crate::workspaces::now_ms;

/// The GitHub App's public client id. Not a secret.
pub const CLIENT_ID: &str = "Iv23liDy3OYs0reC0WZu";
/// From `github.com/apps/<slug>`.
pub const APP_SLUG: &str = "pagemesh-desktop";

const API: &str = "https://api.github.com";
/// The only host that ever gets the token.
const GIT_HOST: &str = "https://github.com/";
/// The keychain item's account name; the service is the app identifier.
const KEYCHAIN_ACCOUNT: &str = "github";
/// Renew the access token when it has less than this left.
const RENEW_BEFORE_MS: u64 = 15 * 60 * 1000;
/// The port in the App's callback URL, `http://127.0.0.1:48159/callback`.
/// GitHub's install page always sends users back there (or, if the port is
/// taken, the app notices the installation by asking); its sign-in page
/// takes any port on 127.0.0.1.
const CALLBACK_PORT: u16 = 48159;
/// Marks the repositories the app creates, so they're found again.
pub const WORKSPACE_TOPIC: &str = "pagemesh-workspace";

/// The App's client secret, built in from `github-client-secret` (see
/// build.rs). It can't be kept secret in a desktop app; PKCE and callbacks
/// that only go to 127.0.0.1 are what protect a sign-in.
fn client_secret() -> Option<&'static str> {
    option_env!("PAGEMESH_GITHUB_CLIENT_SECRET").filter(|s| !s.is_empty())
}

/// Whether this build signs in through the browser, or with a code.
pub fn browser_sign_in() -> bool {
    client_secret().is_some()
}

/// Where to install the App, or change which repositories it can reach.
pub fn install_url() -> String {
    format!("https://github.com/apps/{APP_SLUG}/installations/new")
}

// ---- the account -------------------------------------------------------

/// Read from GitHub's `GET /user` (snake_case) or the keychain, and sent to
/// the window, in camelCase.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct GitHubUser {
    /// Never changes, unlike the login.
    pub id: u64,
    pub login: String,
    pub name: Option<String>,
    #[serde(alias = "avatarUrl")]
    pub avatar_url: String,
}

impl GitHubUser {
    pub fn display_name(&self) -> &str {
        match self.name.as_deref().map(str::trim) {
            Some(name) if !name.is_empty() => name,
            _ => &self.login,
        }
    }

    /// GitHub's no-reply address: keeps real emails out of the history, and
    /// pushes aren't rejected when the user blocks pushes that expose theirs.
    pub fn noreply_email(&self) -> String {
        format!("{}+{}@users.noreply.github.com", self.id, self.login)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tokens {
    access_token: String,
    /// Milliseconds since the Unix epoch; `None` if it never expires.
    expires_at: Option<u64>,
    refresh_token: Option<String>,
    refresh_expires_at: Option<u64>,
}

impl Tokens {
    fn needs_renewal(&self, now: u64) -> bool {
        self.refresh_token.is_some() && self.expires_at.is_some_and(|at| at <= now + RENEW_BEFORE_MS)
    }
}

/// What the keychain item holds, as JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Account {
    user: GitHubUser,
    tokens: Tokens,
}

struct State {
    /// The keychain is read once, the first time anything asks.
    loaded: bool,
    account: Option<Account>,
}

static STATE: Mutex<State> = Mutex::new(State {
    loaded: false,
    account: None,
});
/// The keychain service: the app identifier, set at startup.
static SERVICE: OnceLock<String> = OnceLock::new();
/// Debug builds keep the sign-in in this file instead of the keychain.
static DEV_FILE: OnceLock<PathBuf> = OnceLock::new();
/// Wakes the renewal thread early.
static RENEWER: OnceLock<Sender<()>> = OnceLock::new();
/// Told when the account changes without the window asking, e.g. when the
/// refresh token was revoked.
static ON_CHANGE: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

/// Call once at startup. With `dev_file`, the sign-in is kept in that file
/// instead of the keychain: macOS only lets the program that saved a
/// keychain item read it without asking, and it recognises the program by
/// its signature, which changes with every unsigned debug build.
pub fn init(service: &str, dev_file: Option<PathBuf>, on_change: impl Fn() + Send + Sync + 'static) {
    let _ = SERVICE.set(service.to_string());
    if let Some(file) = dev_file {
        let _ = DEV_FILE.set(file);
    }
    let _ = ON_CHANGE.set(Box::new(on_change));
    let (tx, rx) = mpsc::channel();
    if RENEWER.set(tx).is_ok() {
        std::thread::Builder::new()
            .name("github-renew".into())
            .spawn(move || {
                loop {
                    renew_if_needed();
                    match rx.recv_timeout(Duration::from_secs(60)) {
                        Ok(()) | Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
            })
            .expect("can start a thread");
    }
}

fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    let mut state = STATE.lock().unwrap();
    if !state.loaded {
        state.loaded = true;
        state.account = keychain_load();
    }
    f(&mut state)
}

/// The signed-in user, if any.
pub fn user() -> Option<GitHubUser> {
    with_state(|s| s.account.as_ref().map(|a| a.user.clone()))
}

/// The access token, without waiting on the network. When it has expired,
/// the renewal thread is woken; meanwhile git fails as if offline and the
/// next sync tries again.
pub fn access_token() -> Option<String> {
    let (token, stale) = with_state(|s| {
        s.account
            .as_ref()
            .map(|a| (a.tokens.access_token.clone(), a.tokens.needs_renewal(now_ms())))
            .unzip()
    });
    if stale == Some(true)
        && let Some(renewer) = RENEWER.get()
    {
        let _ = renewer.send(());
    }
    token
}

/// Settings for every git command: the token for github.com only.
pub fn git_config() -> Vec<(String, String)> {
    match access_token() {
        Some(token) => vec![(format!("http.{GIT_HOST}.extraHeader"), auth_header(&token))],
        None => Vec::new(),
    }
}

fn auth_header(token: &str) -> String {
    format!(
        "Authorization: Basic {}",
        base64(format!("x-access-token:{token}").as_bytes())
    )
}

fn set_account(account: Option<Account>) {
    match &account {
        Some(a) => keychain_save(a),
        None => keychain_delete(),
    }
    with_state(|s| s.account = account);
}

/// Forget the sign-in on this device. The App stays authorized on GitHub
/// (Settings → Applications) until the user revokes it there.
pub fn sign_out() {
    if let Some(user) = user() {
        devlog::info("github", format!("Signed out of @{}", user.login));
    }
    set_account(None);
}

fn renew_if_needed() {
    let Some(refresh) = with_state(|s| {
        s.account
            .as_ref()
            .filter(|a| a.tokens.needs_renewal(now_ms()))
            .and_then(|a| a.tokens.refresh_token.clone())
    }) else {
        return;
    };
    let mut fields = vec![
        ("client_id", CLIENT_ID),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh.as_str()),
    ];
    // Tokens from the browser sign-in can only be renewed with the secret.
    if let Some(secret) = client_secret() {
        fields.push(("client_secret", secret));
    }
    let response = post_form(&fields);
    match response.map(|r| interpret(r, now_ms())) {
        Ok(TokenPoll::Done(tokens)) => {
            devlog::info("github", "Renewed the GitHub access token");
            let account = with_state(|s| {
                // Unless they signed out or in again meanwhile.
                let a = s
                    .account
                    .as_mut()
                    .filter(|a| a.tokens.refresh_token.as_ref() == Some(&refresh))?;
                a.tokens = tokens;
                Some(a.clone())
            });
            if let Some(account) = account {
                keychain_save(&account);
            }
        }
        Ok(TokenPoll::Failed(error)) => {
            // The refresh token expired or was revoked: sign in again.
            devlog::warn("github", format!("Couldn't renew the GitHub sign-in: {error}"));
            let still_same = with_state(|s| {
                s.account.as_ref().and_then(|a| a.tokens.refresh_token.as_ref()) == Some(&refresh)
            });
            if still_same {
                set_account(None);
                if let Some(notify) = ON_CHANGE.get() {
                    notify();
                }
            }
        }
        Ok(TokenPoll::Pending | TokenPoll::SlowDown(_)) => {}
        Err(e) => devlog::info(
            "github",
            format!("Couldn't reach GitHub to renew the sign-in: {e}"),
        ),
    }
}

// ---- the device flow ------------------------------------------------------

/// Read from GitHub's snake_case answer, sent to the window in camelCase.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct DeviceCode {
    /// What the user types at `verification_uri`, e.g. "6A1F-24A3".
    pub user_code: String,
    pub verification_uri: String,
    /// Seconds until the code expires.
    pub expires_in: u64,
    #[serde(skip_serializing)]
    device_code: String,
    #[serde(skip_serializing)]
    interval: u64,
}

/// Ask GitHub for a code for the user to enter.
pub fn start_device_flow() -> Result<DeviceCode, String> {
    let mut response = agent()
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .send_form([("client_id", CLIENT_ID)])
        .map_err(|e| format!("Couldn't reach GitHub: {e}"))?;
    let status = response.status().as_u16();
    let body = response.body_mut().read_to_string().map_err(|e| e.to_string())?;
    if status != 200 {
        return Err(format!("GitHub refused to start signing in ({status}): {body}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("Unexpected answer from GitHub: {e}"))
}

/// Wait for the user to approve `code`, then save the sign-in. Stops early,
/// returning `Ok(None)`, once `cancelled` says so.
pub fn finish_device_flow(
    code: &DeviceCode,
    cancelled: impl Fn() -> bool,
) -> Result<Option<GitHubUser>, String> {
    let deadline = now_ms() + code.expires_in * 1000;
    let mut interval = code.interval.max(5);
    loop {
        // Sleep in small steps so cancelling is quick.
        for _ in 0..interval * 4 {
            if cancelled() {
                return Ok(None);
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        if now_ms() > deadline {
            return Err("The code expired. Try signing in again.".into());
        }
        let response = post_form(&[
            ("client_id", CLIENT_ID),
            ("device_code", &code.device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ]);
        let poll = match response {
            Ok(r) => interpret(r, now_ms()),
            // Keep waiting through a dropped connection.
            Err(e) => {
                devlog::info("github", format!("Waiting for sign-in: {e}"));
                continue;
            }
        };
        match poll {
            TokenPoll::Pending => {}
            TokenPoll::SlowDown(next) => interval = next.max(interval + 5),
            TokenPoll::Failed(error) => return Err(error),
            TokenPoll::Done(tokens) => {
                if cancelled() {
                    return Ok(None);
                }
                let user = fetch_user(&tokens.access_token)?;
                devlog::info("github", format!("Signed in as @{}", user.login));
                set_account(Some(Account {
                    user: user.clone(),
                    tokens,
                }));
                return Ok(Some(user));
            }
        }
    }
}

/// GitHub's answer to a token request, polling or renewing.
#[derive(Debug, Default, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
    refresh_token_expires_in: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
    interval: Option<u64>,
}

#[derive(Debug, PartialEq)]
enum TokenPoll {
    Pending,
    /// Poll less often: every this many seconds.
    SlowDown(u64),
    Done(Tokens),
    Failed(String),
}

fn interpret(response: TokenResponse, now: u64) -> TokenPoll {
    if let Some(token) = response.access_token.filter(|t| !t.is_empty()) {
        return TokenPoll::Done(Tokens {
            access_token: token,
            expires_at: response.expires_in.map(|s| now + s * 1000),
            refresh_token: response.refresh_token,
            refresh_expires_at: response.refresh_token_expires_in.map(|s| now + s * 1000),
        });
    }
    match response.error.as_deref() {
        Some("authorization_pending") => TokenPoll::Pending,
        Some("slow_down") => TokenPoll::SlowDown(response.interval.unwrap_or(10)),
        Some("expired_token") => TokenPoll::Failed("The code expired. Try signing in again.".into()),
        Some("access_denied") => TokenPoll::Failed("Signing in was cancelled on GitHub.".into()),
        Some(other) => TokenPoll::Failed(match response.error_description {
            Some(description) => format!("{description} ({other})"),
            None => other.to_string(),
        }),
        None => TokenPoll::Failed("GitHub sent no token".into()),
    }
}

fn post_form(fields: &[(&str, &str)]) -> Result<TokenResponse, String> {
    let mut response = agent()
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .send_form(fields.iter().copied())
        .map_err(|e| e.to_string())?;
    response
        .body_mut()
        .read_json::<TokenResponse>()
        .map_err(|e| format!("Unexpected answer from GitHub: {e}"))
}

// ---- the REST API ----------------------------------------------------------

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .user_agent("Pagemesh-Desktop")
        .build()
        .into()
}

/// A failed API call: the HTTP status (0 when GitHub couldn't be reached)
/// and GitHub's message.
#[derive(Debug)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.status == 0 {
            write!(f, "Couldn't reach GitHub: {}", self.message)
        } else {
            write!(f, "GitHub said: {} ({})", self.message, self.status)
        }
    }
}

fn api<T: serde::de::DeserializeOwned>(
    method: &str,
    path: &str,
    token: &str,
    body: Option<serde_json::Value>,
) -> Result<T, ApiError> {
    api_with(method, path, token, body, "application/vnd.github+json")
}

fn api_with<T: serde::de::DeserializeOwned>(
    method: &str,
    path: &str,
    token: &str,
    body: Option<serde_json::Value>,
    accept: &str,
) -> Result<T, ApiError> {
    let unreachable = |e: ureq::Error| ApiError {
        status: 0,
        message: e.to_string(),
    };
    let url = format!("{API}{path}");
    let agent = agent();
    let auth = format!("Bearer {token}");
    let body = body.unwrap_or(json!({}));
    let mut response = match method {
        "GET" => agent
            .get(&url)
            .header("Authorization", &auth)
            .header("Accept", accept)
            .header("X-GitHub-Api-Version", "2022-11-28")
            .call(),
        "DELETE" => agent
            .delete(&url)
            .header("Authorization", &auth)
            .header("Accept", accept)
            .header("X-GitHub-Api-Version", "2022-11-28")
            .call(),
        "PUT" => agent
            .put(&url)
            .header("Authorization", &auth)
            .header("Accept", accept)
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send_json(body),
        _ => agent
            .post(&url)
            .header("Authorization", &auth)
            .header("Accept", accept)
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send_json(body),
    }
    .map_err(unreachable)?;
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().map_err(unreachable)?;
    if !(200..300).contains(&status) {
        let message = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| api_message(&v))
            .unwrap_or(text);
        return Err(ApiError { status, message });
    }
    // 204 No Content, e.g. after deleting.
    let text = if text.trim().is_empty() {
        "null".to_string()
    } else {
        text
    };
    serde_json::from_str(&text).map_err(|e| ApiError {
        status,
        message: format!("unexpected answer: {e}"),
    })
}

/// GitHub's error message, with the details of a validation error.
fn api_message(body: &serde_json::Value) -> Option<String> {
    let message = body.get("message")?.as_str()?.to_string();
    let details: Vec<&str> = body
        .get("errors")
        .and_then(|e| e.as_array())
        .into_iter()
        .flatten()
        .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
        .collect();
    Some(if details.is_empty() {
        message
    } else {
        format!("{message}: {}", details.join("; "))
    })
}

fn fetch_user(token: &str) -> Result<GitHubUser, String> {
    api("GET", "/user", token, None).map_err(|e| e.to_string())
}

fn signed_in_token() -> Result<String, String> {
    access_token().ok_or_else(|| "Sign in with GitHub first.".to_string())
}

/// Where the App is installed, as far as the signed-in user can see.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    /// Installed on the user's own account.
    pub installed: bool,
    /// It can reach all of the account's repositories, not just chosen ones.
    pub all_repositories: bool,
    /// Where to install it or change its repositories.
    pub manage_url: String,
}

#[derive(Deserialize)]
struct Installations {
    installations: Vec<Installation>,
}

#[derive(Deserialize)]
struct Installation {
    id: u64,
    account: InstallationAccount,
    repository_selection: String,
}

#[derive(Deserialize)]
struct InstallationAccount {
    id: u64,
}

fn installations(token: &str) -> Result<Vec<Installation>, String> {
    api::<Installations>("GET", "/user/installations?per_page=100", token, None)
        .map(|found| found.installations)
        .map_err(|e| e.to_string())
}

fn installed_on(token: &str, user: &GitHubUser) -> Result<bool, String> {
    Ok(installations(token)?.iter().any(|i| i.account.id == user.id))
}

pub fn access() -> Result<Access, String> {
    let token = signed_in_token()?;
    let user = user().ok_or("Sign in with GitHub first.")?;
    let own = installations(&token)?
        .into_iter()
        .find(|i| i.account.id == user.id);
    Ok(match own {
        Some(i) => Access {
            installed: true,
            all_repositories: i.repository_selection == "all",
            manage_url: format!("https://github.com/settings/installations/{}", i.id),
        },
        None => Access {
            installed: false,
            all_repositories: false,
            manage_url: install_url(),
        },
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct Repo {
    pub full_name: String,
    pub clone_url: String,
}

/// A repository name GitHub accepts, from a workspace name.
pub fn repo_name(workspace: &str) -> String {
    let mut out = String::new();
    for c in workspace.trim().chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '_' {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches(|c| c == '-' || c == '.').to_string();
    if out.is_empty() { "notes".into() } else { out }
}

/// Create a private repository for a workspace on the user's account,
/// picking "Name-2" and so on if the name is taken.
pub fn create_private_repo(workspace: &str) -> Result<Repo, String> {
    let token = signed_in_token()?;
    let base = repo_name(workspace);
    for n in 1..=20 {
        let name = if n == 1 {
            base.clone()
        } else {
            format!("{base}-{n}")
        };
        let body = json!({
            "name": name,
            "private": true,
            "description": format!("{} — a Pagemesh workspace", workspace.trim()),
            "has_issues": false,
            "has_projects": false,
            "has_wiki": false,
        });
        match api::<Repo>("POST", "/user/repos", &token, Some(body)) {
            Ok(repo) => {
                devlog::info("github", format!("Created the private repo {}", repo.full_name));
                // Only for finding it again from other devices; the
                // workspace.json check finds it without the topic too.
                let topics = json!({ "names": [WORKSPACE_TOPIC] });
                if let Err(e) = api::<serde_json::Value>(
                    "PUT",
                    &format!("/repos/{}/topics", repo.full_name),
                    &token,
                    Some(topics),
                ) {
                    devlog::info("github", format!("Couldn't tag {}: {e}", repo.full_name));
                }
                return Ok(repo);
            }
            Err(e) if e.status == 422 && e.message.contains("already exists") => continue,
            Err(e) if e.status == 403 || e.status == 404 => {
                return Err(format!(
                    "Pagemesh isn't allowed to create repositories on your account yet. Install it \
                     on your account at {} and try again. ({e})",
                    install_url()
                ));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Err(format!(
        "You already have repositories called {base}, {base}-2 and so on up to 20."
    ))
}

/// "owner/repo" for a github.com remote URL (HTTPS or SSH).
pub fn repo_from_url(url: &str) -> Option<String> {
    let url = url.trim();
    let rest = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("git@github.com:"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))?;
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let (owner, repo) = rest.split_once('/')?;
    let valid = |part: &str| !part.is_empty() && !part.contains('/');
    (valid(owner) && valid(repo)).then(|| format!("{owner}/{repo}"))
}

/// Delete a repository on GitHub. GitHub keeps it restorable from the
/// owner's settings for 90 days.
pub fn delete_repo(full_name: &str) -> Result<(), String> {
    let token = signed_in_token()?;
    match api::<serde_json::Value>("DELETE", &format!("/repos/{full_name}"), &token, None) {
        Ok(_) => {
            devlog::info("github", format!("Deleted the repo {full_name}"));
            Ok(())
        }
        Err(e) if e.status == 403 => Err(format!(
            "GitHub didn't let Pagemesh delete {full_name}. Only its owner or an admin can delete it. ({e})"
        )),
        Err(e) if e.status == 404 => Err(format!(
            "{full_name} wasn't found on GitHub, or Pagemesh can't reach it."
        )),
        Err(e) => Err(e.to_string()),
    }
}

/// Whether the App can reach `full_name` (e.g. "ada/notes") with the
/// user's sign-in. A repository the user owns but didn't give the App
/// answers 404, the same as one that doesn't exist.
pub fn can_reach(full_name: &str) -> Result<bool, String> {
    let token = signed_in_token()?;
    match api::<serde_json::Value>("GET", &format!("/repos/{full_name}"), &token, None) {
        Ok(_) => Ok(true),
        Err(e) if e.status == 404 || e.status == 403 => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

/// A workspace on GitHub this device could join.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspace {
    /// "ada/My-Notes".
    pub full_name: String,
    /// From its workspace.json.
    pub name: String,
    pub clone_url: String,
}

#[derive(Deserialize)]
struct InstallationRepos {
    repositories: Vec<ListedRepo>,
}

#[derive(Deserialize)]
struct ListedRepo {
    full_name: String,
    clone_url: String,
    #[serde(default)]
    topics: Vec<String>,
}

/// Look in at most this many untagged repositories for a workspace.json;
/// tagged ones are always looked at.
const MAX_UNTAGGED_CHECKS: usize = 40;

/// The workspaces in the repositories the App can reach, for joining them
/// on this device. A repository holds one when it has a workspace.json.
pub fn workspaces() -> Result<Vec<RemoteWorkspace>, String> {
    let token = signed_in_token()?;
    let mut repos = Vec::new();
    for installation in installations(&token)? {
        let listed: InstallationRepos = api(
            "GET",
            &format!(
                "/user/installations/{}/repositories?per_page=100",
                installation.id
            ),
            &token,
            None,
        )
        .map_err(|e| e.to_string())?;
        repos.extend(listed.repositories);
    }
    let (tagged, untagged): (Vec<_>, Vec<_>) = repos
        .into_iter()
        .partition(|r| r.topics.iter().any(|t| t == WORKSPACE_TOPIC));
    let candidates: Vec<ListedRepo> = tagged
        .into_iter()
        .chain(untagged.into_iter().take(MAX_UNTAGGED_CHECKS))
        .collect();
    let mut found: Vec<RemoteWorkspace> = std::thread::scope(|scope| {
        let checks: Vec<_> = candidates
            .iter()
            .map(|repo| {
                let token = &token;
                scope.spawn(move || workspace_name(token, &repo.full_name).map(|name| (repo, name)))
            })
            .collect();
        checks
            .into_iter()
            .filter_map(|c| c.join().ok().flatten())
            .map(|(repo, name)| RemoteWorkspace {
                full_name: repo.full_name.clone(),
                name,
                clone_url: repo.clone_url.clone(),
            })
            .collect()
    });
    found.sort_by_key(|w| w.name.to_lowercase());
    Ok(found)
}

/// The workspace's name if `full_name` holds a workspace.
fn workspace_name(token: &str, full_name: &str) -> Option<String> {
    let path = format!("/repos/{full_name}/contents/{}", docsync::layout::WORKSPACE_FILE);
    let json: serde_json::Value =
        api_with("GET", &path, token, None, "application/vnd.github.raw+json").ok()?;
    let name = json
        .get("name")
        .and_then(|n| n.as_str())
        .map(str::trim)
        .unwrap_or("");
    Some(if name.is_empty() {
        full_name.rsplit('/').next().unwrap_or(full_name).to_string()
    } else {
        name.to_string()
    })
}

// ---- signing in through the browser ----------------------------------------

/// What GitHub sent back to the listener.
#[derive(Debug, Default, PartialEq)]
struct Callback {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// Sign in through the browser with GitHub's sign-in page, saving the
/// sign-in; then, if the App isn't installed on the user's account, have
/// them install it. Someone who has signed in before comes straight back
/// without a click; someone new clicks Authorize, then Install. `open`
/// opens a URL in the browser, `installing` is called when the install
/// page opens. `Ok(None)` when cancelled.
pub fn sign_in_with_browser(
    open: impl Fn(&str) -> Result<(), String>,
    installing: impl Fn(),
    cancelled: impl Fn() -> bool,
) -> Result<Option<GitHubUser>, String> {
    let secret = client_secret().ok_or("This build can't sign in through the browser.")?;
    let state = random_token();
    let listener =
        TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("Can't listen for GitHub: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let verifier = random_token();
    let url = format!(
        "https://github.com/login/oauth/authorize?client_id={CLIENT_ID}&redirect_uri={}&state={state}\
         &code_challenge={}&code_challenge_method=S256",
        percent_encode(&redirect),
        pkce_challenge(&verifier)
    );
    open(&url)?;
    let Some(callback) = wait_for_callback(&listener, &state, &cancelled, || false)? else {
        return Ok(None);
    };
    drop(listener);
    let code = callback.code.ok_or("GitHub didn't send a sign-in code.")?;
    let tokens = exchange_code(secret, &code, Some((&verifier, &redirect)))?;
    let user = fetch_user(&tokens.access_token)?;
    let token = tokens.access_token.clone();
    devlog::info("github", format!("Signed in as @{}", user.login));
    set_account(Some(Account {
        user: user.clone(),
        tokens,
    }));

    if !installed_on(&token, &user)? {
        devlog::info(
            "github",
            "Pagemesh isn't installed on the account yet; opening the install page",
        );
        // The install page always returns to the callback URL's fixed port.
        let listener = TcpListener::bind(("127.0.0.1", CALLBACK_PORT))
            .map_err(|e| devlog::info("github", format!("Port {CALLBACK_PORT} is taken ({e})")))
            .ok();
        installing();
        let state = random_token();
        open(&format!(
            "https://github.com/apps/{APP_SLUG}/installations/new/permissions?target_id={}&state={state}",
            user.id
        ))?;
        // Done when GitHub sends the browser back, or, if the port was
        // taken, when the installation shows up.
        let mut last_check = std::time::Instant::now();
        let installed = || {
            if last_check.elapsed() < Duration::from_secs(4) {
                return false;
            }
            last_check = std::time::Instant::now();
            installed_on(&token, &user).unwrap_or(false)
        };
        // If they cancel here they're still signed in; onboarding and the
        // sync panel then offer to install.
        match &listener {
            Some(listener) => {
                wait_for_callback(listener, &state, &cancelled, installed)?;
            }
            None => {
                wait_until(&cancelled, installed);
            }
        }
    }
    Ok(Some(user))
}

fn exchange_code(secret: &str, code: &str, pkce: Option<(&str, &str)>) -> Result<Tokens, String> {
    let mut fields = vec![
        ("client_id", CLIENT_ID),
        ("client_secret", secret),
        ("code", code),
    ];
    if let Some((verifier, redirect)) = pkce {
        fields.push(("code_verifier", verifier));
        fields.push(("redirect_uri", redirect));
    }
    match interpret(post_form(&fields)?, now_ms()) {
        TokenPoll::Done(tokens) => Ok(tokens),
        TokenPoll::Failed(error) => Err(format!("GitHub didn't accept the sign-in: {error}")),
        TokenPoll::Pending | TokenPoll::SlowDown(_) => Err("GitHub didn't accept the sign-in.".into()),
    }
}

/// Give up waiting for the browser after this long.
const BROWSER_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Wait until `done` says so, checking `cancelled` meanwhile. False when
/// cancelled or timed out.
fn wait_until(cancelled: &impl Fn() -> bool, mut done: impl FnMut() -> bool) -> bool {
    let started = std::time::Instant::now();
    while started.elapsed() < BROWSER_TIMEOUT {
        if cancelled() {
            return false;
        }
        if done() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

/// Answer requests on `listener` until GitHub's callback with `state`
/// arrives (`Some`), or `cancelled` or `also_done` says to stop (`None`,
/// or `Some` of an empty callback when `also_done`).
fn wait_for_callback(
    listener: &TcpListener,
    state: &str,
    cancelled: &impl Fn() -> bool,
    mut also_done: impl FnMut() -> bool,
) -> Result<Option<Callback>, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let started = std::time::Instant::now();
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(callback) = answer(stream, state) {
                    if let Some(error) = callback.error {
                        return Err(if error == "access_denied" {
                            "Signing in was cancelled on GitHub.".into()
                        } else {
                            format!("GitHub said: {error}")
                        });
                    }
                    return Ok(Some(callback));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if cancelled() || started.elapsed() > BROWSER_TIMEOUT {
                    return Ok(None);
                }
                if also_done() {
                    return Ok(Some(Callback::default()));
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(format!("Stopped listening for GitHub: {e}")),
        }
    }
}

/// Read one request and answer it. The callback (with the right state)
/// gets a page saying to return to the app; anything else (a favicon, a
/// stale tab) a 404.
fn answer(mut stream: TcpStream, state: &str) -> Option<Callback> {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).unwrap_or(0);
    let request = String::from_utf8_lossy(&buf[..n]);
    let callback =
        parse_callback(request.lines().next().unwrap_or("")).filter(|c| c.state.as_deref() == Some(state));
    let (status, body) = match &callback {
        Some(c) if c.error.is_none() => (
            "200 OK",
            CALLBACK_PAGE.replace(
                "{message}",
                "You're signed in. You can close this tab and go back to Pagemesh.",
            ),
        ),
        Some(_) => (
            "200 OK",
            CALLBACK_PAGE.replace(
                "{message}",
                "Signing in didn't finish. Go back to Pagemesh to try again.",
            ),
        ),
        None => (
            "404 Not Found",
            CALLBACK_PAGE.replace("{message}", "Nothing here."),
        ),
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    callback
}

const CALLBACK_PAGE: &str = "<!doctype html><html><head><meta charset=utf-8><title>Pagemesh</title>\
<style>body{font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;\
margin:0;color:#222;background:#fafafa}@media(prefers-color-scheme:dark){body{color:#eee;background:#1e1e1e}}\
</style></head><body><p>{message}</p></body></html>";

/// The query of `GET /callback?…` from a request line.
fn parse_callback(request_line: &str) -> Option<Callback> {
    let target = request_line.strip_prefix("GET ")?.split(' ').next()?;
    let query = target.strip_prefix("/callback")?.strip_prefix('?').unwrap_or("");
    let mut callback = Callback::default();
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value = percent_decode(value);
        match key {
            "code" => callback.code = Some(value),
            "state" => callback.state = Some(value),
            "error" => callback.error = Some(value),
            _ => {}
        }
    }
    Some(callback)
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the system has randomness");
    base64url(&bytes)
}

fn pkce_challenge(verifier: &str) -> String {
    use sha2::Digest;
    base64url(&sha2::Sha256::digest(verifier.as_bytes()))
}

fn base64url(bytes: &[u8]) -> String {
    base64(bytes)
        .trim_end_matches('=')
        .replace('+', "-")
        .replace('/', "_")
}

fn percent_encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok());
        match (bytes[i], hex.and_then(|h| u8::from_str_radix(h, 16).ok())) {
            (b'%', Some(b)) => {
                out.push(b);
                i += 3;
                continue;
            }
            (b'+', _) => out.push(b' '),
            (b, _) => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---- the keychain ----------------------------------------------------------

fn keychain_entry() -> Option<keyring::Entry> {
    let service = SERVICE.get()?;
    keyring::Entry::new(service, KEYCHAIN_ACCOUNT)
        .map_err(|e| devlog::warn("github", format!("No keychain: {e}")))
        .ok()
}

fn keychain_load() -> Option<Account> {
    if let Some(file) = DEV_FILE.get() {
        return dev_file_load(file);
    }
    match keychain_entry()?.get_password() {
        Ok(json) => serde_json::from_str(&json)
            .map_err(|e| devlog::warn("github", format!("Ignoring an unreadable sign-in: {e}")))
            .ok(),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            devlog::warn(
                "github",
                format!("Couldn't read the sign-in from the keychain: {e}"),
            );
            None
        }
    }
}

fn keychain_save(account: &Account) {
    if let Some(file) = DEV_FILE.get() {
        return dev_file_save(file, account);
    }
    let Some(entry) = keychain_entry() else { return };
    let json = serde_json::to_string(account).expect("serializable");
    if let Err(e) = entry.set_password(&json) {
        devlog::error(
            "github",
            format!("Couldn't save the sign-in in the keychain: {e}"),
        );
    }
}

fn keychain_delete() {
    if let Some(file) = DEV_FILE.get() {
        if let Err(e) = std::fs::remove_file(file)
            && e.kind() != std::io::ErrorKind::NotFound
        {
            devlog::warn("github", format!("Couldn't remove {}: {e}", file.display()));
        }
        return;
    }
    let Some(entry) = keychain_entry() else { return };
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => devlog::warn(
            "github",
            format!("Couldn't remove the sign-in from the keychain: {e}"),
        ),
    }
}

// ---- the debug builds' file ------------------------------------------------

fn dev_file_load(file: &Path) -> Option<Account> {
    let json = std::fs::read_to_string(file).ok()?;
    serde_json::from_str(&json)
        .map_err(|e| devlog::warn("github", format!("Ignoring an unreadable sign-in: {e}")))
        .ok()
}

fn dev_file_save(file: &Path, account: &Account) {
    let json = serde_json::to_string(account).expect("serializable");
    let written = (|| {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        options.open(file)?.write_all(json.as_bytes())
    })();
    if let Err(e) = written {
        devlog::error(
            "github",
            format!("Couldn't save the sign-in in {}: {e}", file.display()),
        );
    }
}

// ---- helpers ---------------------------------------------------------------

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> shift) as usize & 63] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_users_from_github_and_the_keychain() {
        let from_github: GitHubUser = serde_json::from_str(
            r#"{"login":"ada","id":42,"avatar_url":"https://avatars.githubusercontent.com/u/42?v=4",
                "name":"Ada","type":"User","site_admin":false}"#,
        )
        .unwrap();
        assert_eq!(
            from_github.avatar_url,
            "https://avatars.githubusercontent.com/u/42?v=4"
        );
        let saved = serde_json::to_string(&from_github).unwrap();
        assert!(saved.contains("\"avatarUrl\""), "{saved}");
        assert_eq!(serde_json::from_str::<GitHubUser>(&saved).unwrap(), from_github);
    }

    #[test]
    fn debug_builds_keep_the_sign_in_in_a_private_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config").join("dev-sign-in.json");
        let account = Account {
            user: GitHubUser {
                id: 42,
                login: "ada".into(),
                name: Some("Ada".into()),
                avatar_url: String::new(),
            },
            tokens: Tokens {
                access_token: "t".into(),
                expires_at: Some(1),
                refresh_token: Some("r".into()),
                refresh_expires_at: None,
            },
        };
        assert!(dev_file_load(&file).is_none());
        dev_file_save(&file, &account);
        let read = dev_file_load(&file).unwrap();
        assert_eq!((read.user, read.tokens), (account.user, account.tokens));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&file).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn reads_device_codes() {
        let code: DeviceCode = serde_json::from_str(
            r#"{"device_code":"d","user_code":"6A1F-24A3","verification_uri":"https://github.com/login/device",
                "expires_in":899,"interval":5}"#,
        )
        .unwrap();
        assert_eq!((code.user_code.as_str(), code.interval), ("6A1F-24A3", 5));
        let sent = serde_json::to_value(&code).unwrap();
        assert_eq!(sent["userCode"], "6A1F-24A3");
        assert!(sent.get("deviceCode").is_none(), "the device code stays in Rust");
    }

    #[test]
    fn finds_repos_in_remote_urls() {
        for url in [
            "https://github.com/ada/My-Notes.git",
            "https://github.com/ada/My-Notes",
            "git@github.com:ada/My-Notes.git",
            "ssh://git@github.com/ada/My-Notes.git",
        ] {
            assert_eq!(repo_from_url(url).as_deref(), Some("ada/My-Notes"), "{url}");
        }
        assert_eq!(repo_from_url("https://gitlab.com/ada/notes.git"), None);
        assert_eq!(repo_from_url("/Volumes/USB/notes.git"), None);
        assert_eq!(repo_from_url("https://github.com/ada"), None);
        assert_eq!(repo_from_url("https://github.com/ada/notes/tree/main"), None);
    }

    #[test]
    fn reads_callbacks() {
        assert_eq!(
            parse_callback(
                "GET /callback?code=abc&installation_id=1&setup_action=install&state=x%2By HTTP/1.1"
            ),
            Some(Callback {
                code: Some("abc".into()),
                state: Some("x+y".into()),
                error: None,
            })
        );
        assert_eq!(
            parse_callback("GET /callback?error=access_denied&state=s HTTP/1.1")
                .unwrap()
                .error
                .as_deref(),
            Some("access_denied")
        );
        assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1"), None);
        assert_eq!(parse_callback("POST /callback?code=a HTTP/1.1"), None);
    }

    #[test]
    fn makes_pkce_challenges() {
        // RFC 7636, appendix B.
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let token = random_token();
        assert_eq!(token.len(), 43);
        assert!(
            token
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
    }

    #[test]
    fn percent_codes() {
        assert_eq!(
            percent_encode("http://127.0.0.1:5/callback"),
            "http%3A%2F%2F127.0.0.1%3A5%2Fcallback"
        );
        assert_eq!(percent_decode("a%20b+c%2"), "a b c%2");
    }

    #[test]
    fn answers_the_browser() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let browser = std::thread::spawn(move || {
            let mut favicon = TcpStream::connect(("127.0.0.1", port)).unwrap();
            favicon.write_all(b"GET /favicon.ico HTTP/1.1\r\n\r\n").unwrap();
            let mut reply = String::new();
            favicon.read_to_string(&mut reply).unwrap();
            assert!(reply.starts_with("HTTP/1.1 404"), "{reply}");
            let mut tab = TcpStream::connect(("127.0.0.1", port)).unwrap();
            tab.write_all(b"GET /callback?code=c0de&state=st HTTP/1.1\r\nHost: x\r\n\r\n")
                .unwrap();
            let mut reply = String::new();
            tab.read_to_string(&mut reply).unwrap();
            assert!(
                reply.starts_with("HTTP/1.1 200") && reply.contains("signed in"),
                "{reply}"
            );
        });
        let callback = wait_for_callback(&listener, "st", &|| false, || false)
            .unwrap()
            .unwrap();
        browser.join().unwrap();
        assert_eq!(callback.code.as_deref(), Some("c0de"));
    }

    #[test]
    fn encodes_base64() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(
            base64(b"x-access-token:ghu_abc"),
            "eC1hY2Nlc3MtdG9rZW46Z2h1X2FiYw=="
        );
    }

    #[test]
    fn reads_token_answers() {
        let done = interpret(
            serde_json::from_str(
                r#"{"access_token":"ghu_a","expires_in":28800,"refresh_token":"ghr_b",
                    "refresh_token_expires_in":15897600,"token_type":"bearer","scope":""}"#,
            )
            .unwrap(),
            1000,
        );
        assert_eq!(
            done,
            TokenPoll::Done(Tokens {
                access_token: "ghu_a".into(),
                expires_at: Some(1000 + 28_800_000),
                refresh_token: Some("ghr_b".into()),
                refresh_expires_at: Some(1000 + 15_897_600_000),
            })
        );
        let pending = TokenResponse {
            error: Some("authorization_pending".into()),
            ..Default::default()
        };
        assert_eq!(interpret(pending, 0), TokenPoll::Pending);
        let slow = TokenResponse {
            error: Some("slow_down".into()),
            interval: Some(10),
            ..Default::default()
        };
        assert_eq!(interpret(slow, 0), TokenPoll::SlowDown(10));
        let denied = TokenResponse {
            error: Some("access_denied".into()),
            ..Default::default()
        };
        assert!(matches!(interpret(denied, 0), TokenPoll::Failed(_)));
    }

    #[test]
    fn renews_shortly_before_expiry() {
        let tokens = |expires_at| Tokens {
            access_token: "a".into(),
            expires_at,
            refresh_token: Some("r".into()),
            refresh_expires_at: None,
        };
        let now = 10_000_000;
        assert!(!tokens(Some(now + 60 * 60 * 1000)).needs_renewal(now));
        assert!(tokens(Some(now + 60 * 1000)).needs_renewal(now));
        assert!(tokens(Some(now - 1)).needs_renewal(now));
        assert!(!tokens(None).needs_renewal(now), "tokens that never expire");
    }

    #[test]
    fn names_repositories_after_workspaces() {
        assert_eq!(repo_name("My Notes"), "My-Notes");
        assert_eq!(repo_name("  Team notes / 2026 "), "Team-notes-2026");
        assert_eq!(repo_name("Ünïcode café"), "n-code-caf");
        assert_eq!(repo_name("???"), "notes");
        assert_eq!(repo_name("v1.2_final"), "v1.2_final");
    }

    #[test]
    fn uses_the_noreply_address() {
        let user = GitHubUser {
            id: 42,
            login: "ada".into(),
            name: Some("  ".into()),
            avatar_url: String::new(),
        };
        assert_eq!(user.noreply_email(), "42+ada@users.noreply.github.com");
        assert_eq!(user.display_name(), "ada");
    }

    #[test]
    fn reads_validation_errors() {
        let body = json!({"message": "Repository creation failed.",
            "errors": [{"resource": "Repository", "code": "custom", "field": "name",
                        "message": "name already exists on this account"}]});
        assert_eq!(
            api_message(&body).unwrap(),
            "Repository creation failed.: name already exists on this account"
        );
    }
}
