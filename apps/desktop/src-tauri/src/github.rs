//! Signing in with GitHub, through the "Pagemesh Desktop" GitHub App.
//!
//! The app signs in with the device flow (a code the user enters at
//! github.com/login/device), so it needs no client secret and no web
//! server. The App can only reach repositories the user installed it on,
//! unlike an OAuth app's `repo` scope, which reaches every private repo.
//!
//! The access token lasts 8 hours and is renewed in the background with the
//! refresh token (good for 6 months). Both live in the system keychain,
//! never in a file. Git gets the token in an `http.<url>.extraHeader`
//! setting, through the environment, so it stays out of `.git/config`,
//! remote URLs and process listings.

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
/// Wakes the renewal thread early.
static RENEWER: OnceLock<Sender<()>> = OnceLock::new();
/// Told when the account changes without the window asking, e.g. when the
/// refresh token was revoked.
static ON_CHANGE: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

/// Call once at startup.
pub fn init(service: &str, on_change: impl Fn() + Send + Sync + 'static) {
    let _ = SERVICE.set(service.to_string());
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
    let response = post_form(&[
        ("client_id", CLIENT_ID),
        ("grant_type", "refresh_token"),
        ("refresh_token", &refresh),
    ]);
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
    let unreachable = |e: ureq::Error| ApiError {
        status: 0,
        message: e.to_string(),
    };
    let url = format!("{API}{path}");
    let agent = agent();
    let auth = format!("Bearer {token}");
    let mut response = match (method, body) {
        ("GET", _) => agent
            .get(&url)
            .header("Authorization", &auth)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .call(),
        (_, body) => agent
            .post(&url)
            .header("Authorization", &auth)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send_json(body.unwrap_or(json!({}))),
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

pub fn access() -> Result<Access, String> {
    let token = signed_in_token()?;
    let user = user().ok_or("Sign in with GitHub first.")?;
    let found: Installations = api("GET", "/user/installations", &token, None).map_err(|e| e.to_string())?;
    let own = found.installations.into_iter().find(|i| i.account.id == user.id);
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

// ---- the keychain ----------------------------------------------------------

fn keychain_entry() -> Option<keyring::Entry> {
    let service = SERVICE.get()?;
    keyring::Entry::new(service, KEYCHAIN_ACCOUNT)
        .map_err(|e| devlog::warn("github", format!("No keychain: {e}")))
        .ok()
}

fn keychain_load() -> Option<Account> {
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
    let Some(entry) = keychain_entry() else { return };
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => devlog::warn(
            "github",
            format!("Couldn't remove the sign-in from the keychain: {e}"),
        ),
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
