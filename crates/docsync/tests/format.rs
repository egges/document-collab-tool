//! The workspace format version: a version of the app that finds a newer
//! format than it knows refuses to open, join or merge it, and changes
//! nothing. See "Workspace format" in docs/sync-design.md.

mod common;

use std::fs;
use std::path::Path;
use std::sync::Arc;

use common::{Net, real_git};
use docsync::{Error, SyncConfig, SyncEngine, WORKSPACE_FORMAT};
use serde_json::json;

/// Make `root` look like a newer app saved it.
fn write_format(root: &Path, format: u32) {
    let path = root.join("workspace.json");
    let mut settings: serde_json::Value = fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| json!({}));
    settings["format"] = json!(format);
    fs::write(&path, serde_json::to_vec_pretty(&settings).unwrap()).unwrap();
}

fn is_newer_format(result: Result<impl std::fmt::Debug, Error>) -> bool {
    matches!(
        result,
        Err(Error::NewerFormat { found, supported })
            if found == WORKSPACE_FORMAT + 1 && supported == WORKSPACE_FORMAT
    )
}

#[test]
fn new_workspaces_record_the_current_format() {
    let net = Net::new();
    let a = net.device("a");
    let head = a.engine.head().unwrap().unwrap();
    assert_eq!(a.engine.format_at(&head).unwrap(), WORKSPACE_FORMAT);
}

#[test]
fn a_workspace_without_a_format_is_format_1() {
    let net = Net::new();
    let a = net.device("a");
    fs::write(a.root().join("workspace.json"), b"{\"name\": \"Old\"}\n").unwrap();
    a.commit();
    let head = a.engine.head().unwrap().unwrap();
    assert_eq!(a.engine.format_at(&head).unwrap(), 1);

    fs::remove_file(a.root().join("workspace.json")).unwrap();
    a.commit();
    let head = a.engine.head().unwrap().unwrap();
    assert_eq!(a.engine.format_at(&head).unwrap(), 1);
    // And it still opens.
    let a = net.reopen(a);
    assert!(a.engine.head().unwrap().is_some());
}

#[test]
fn changes_in_a_newer_format_are_not_merged() {
    let net = Net::new();
    let (a, b) = (net.device("a"), net.device("b"));
    let page = a.ws.create_page("Shared", None).unwrap();
    a.ws.write_body(&page, "One\n").unwrap();
    a.sync();
    b.sync();

    // A newer app on `a` migrates the workspace.
    write_format(a.root(), WORKSPACE_FORMAT + 1);
    a.ws.write_body(&page, "One\nFrom the newer app\n").unwrap();
    a.sync();
    let remote_before = a.engine.head().unwrap().unwrap();

    // `b` has its own edit: it is kept, but not merged or published.
    b.ws.write_body(&page, "One\nFrom b\n").unwrap();
    assert!(is_newer_format(b.engine.sync()));
    assert_eq!(b.ws.read_body(&page).unwrap(), "One\nFrom b\n");
    let b_head = b.engine.head().unwrap().unwrap();
    assert_eq!(b.engine.format_at(&b_head).unwrap(), WORKSPACE_FORMAT);
    assert!(!a.sync().pushed);
    assert_eq!(a.engine.head().unwrap().unwrap(), remote_before);
}

#[test]
fn changes_in_a_newer_format_are_not_fast_forwarded() {
    let net = Net::new();
    let (a, b) = (net.device("a"), net.device("b"));
    write_format(a.root(), WORKSPACE_FORMAT + 1);
    a.sync();

    let before = b.engine.head().unwrap();
    assert!(is_newer_format(b.engine.sync()));
    assert_eq!(b.engine.head().unwrap(), before);
}

#[test]
fn a_workspace_in_a_newer_format_does_not_open() {
    let net = Net::new();
    let a = net.device("a");
    write_format(a.root(), WORKSPACE_FORMAT + 1);
    a.commit();
    let root = a.root().to_path_buf();
    drop(a);
    let opened = SyncEngine::open(
        Arc::new(real_git()),
        root,
        SyncConfig::new("a"),
        net.clock.clone(),
    );
    assert!(is_newer_format(opened.map(|_| ())));
}

#[test]
fn a_workspace_in_a_newer_format_cannot_be_joined() {
    let net = Net::new();
    let a = net.device("a");
    write_format(a.root(), WORKSPACE_FORMAT + 1);
    a.sync();

    let root = net.path().join("c");
    let joined = SyncEngine::clone_remote(
        Arc::new(real_git()),
        &net.url(),
        &root,
        SyncConfig::new("c"),
        net.clock.clone(),
    );
    assert!(is_newer_format(joined.map(|_| ())));
    assert!(!root.join("workspace.json").exists(), "nothing was checked out");
}

#[test]
fn a_folder_remote_in_a_newer_format_is_not_merged() {
    let net = Net::folder();
    let (a, b) = (net.device("a"), net.device("b"));
    net.settle(&[&a, &b]);
    write_format(a.root(), WORKSPACE_FORMAT + 1);
    a.sync();
    net.cloud.as_ref().unwrap().settle();

    let before = b.engine.head().unwrap();
    assert!(is_newer_format(b.engine.sync()));
    assert_eq!(b.engine.head().unwrap(), before);
}
