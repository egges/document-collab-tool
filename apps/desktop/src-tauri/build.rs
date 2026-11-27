fn main() {
    // The GitHub App's client secret, for signing in through the browser
    // (see `github::client_secret`). It comes from the environment or from
    // the gitignored file `github-client-secret`, never from git. Without
    // it the app falls back to signing in with a code (the device flow).
    println!("cargo:rerun-if-changed=github-client-secret");
    println!("cargo:rerun-if-env-changed=SAWMILL_GITHUB_CLIENT_SECRET");
    let secret = std::env::var("SAWMILL_GITHUB_CLIENT_SECRET")
        .ok()
        .or_else(|| std::fs::read_to_string("github-client-secret").ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    println!("cargo:rustc-env=SAWMILL_GITHUB_CLIENT_SECRET={secret}");
    tauri_build::build()
}
