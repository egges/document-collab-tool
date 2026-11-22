//! Pointing a workspace at another remote: the history goes along, a
//! remote holding a different workspace is refused, and a folder remote
//! survives what sync services and users do to folders.

mod common;

use std::path::Path;

use common::{Net, git_command, real_git};
use docsync::{Error, RemoteLayout, SyncEngine};

fn folder_layout(device: &str) -> RemoteLayout {
    RemoteLayout::DeviceRefs {
        device_id: device.to_string(),
    }
}

fn rev(git_dir: &Path, rev: &str) -> Option<String> {
    let out = git_command()
        .arg("--git-dir")
        .arg(git_dir)
        .args(["rev-parse", "-q", "--verify", rev])
        .output()
        .unwrap();
    out.status
        .success()
        .then(|| String::from_utf8(out.stdout).unwrap().trim().to_string())
}

fn bare(path: &Path) {
    let status = git_command()
        .args(["init", "-q", "--bare", "-b", "main"])
        .arg(path)
        .status()
        .unwrap();
    assert!(status.success());
}

/// Remove every empty folder below `dir`, as a service that doesn't sync
/// empty folders would leave it on another device.
fn remove_empty_dirs(dir: &Path) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        if entry.file_type().unwrap().is_dir() {
            remove_empty_dirs(&entry.path());
            let _ = std::fs::remove_dir(entry.path());
        }
    }
}

#[test]
fn a_new_folder_gets_the_whole_history_even_without_its_empty_folders() {
    let net = Net::new();
    let a = net.device("a");
    a.ws.create_page_with_id("p", "Before the switch", None).unwrap();
    a.commit();
    a.sync();

    let folder = net.path().join("Dropbox").join("Notes.docsync");
    std::fs::create_dir_all(folder.parent().unwrap()).unwrap();
    SyncEngine::create_folder_remote(&real_git(), &folder).unwrap();
    remove_empty_dirs(&folder);
    assert!(!folder.join("refs").exists());

    a.engine
        .switch_remote(&folder.to_string_lossy(), folder_layout("a"))
        .unwrap();
    assert!(a.sync().pushed);
    assert_eq!(rev(&folder, "refs/heads/devices/a"), Some(a.head().to_string()));

    // Another device joins from a copy that lost its empty folders too.
    remove_empty_dirs(&folder);
    let mut config = docsync::SyncConfig::new("b");
    config.layout = folder_layout("b");
    let b = SyncEngine::clone_remote(
        std::sync::Arc::new(real_git()),
        &folder.to_string_lossy(),
        net.path().join("b"),
        config,
        net.clock.clone(),
    )
    .unwrap();
    assert!(docsync::Workspace::new(b.root()).page_exists("p"));
}

#[test]
fn a_remote_holding_a_different_workspace_is_refused() {
    let (ours, theirs) = (Net::new(), Net::new());
    let a = ours.device("a");
    let stranger = theirs.device("stranger");
    stranger
        .ws
        .create_page_with_id("x", "Someone else's", None)
        .unwrap();
    stranger.commit();
    stranger.sync();

    let refused = a.engine.switch_remote(&theirs.url(), RemoteLayout::SharedBranch);
    assert!(
        matches!(refused, Err(Error::DifferentWorkspace(_))),
        "{refused:?}"
    );

    // Still syncing where it did, and nothing was mixed in.
    a.ws.create_page_with_id("p", "Ours", None).unwrap();
    a.commit();
    assert!(a.sync().pushed);
    assert_eq!(rev(&ours.remote, "main"), Some(a.head().to_string()));
    assert!(!a.ws.page_exists("x"));
}

#[test]
fn a_remote_with_the_same_workspace_is_fine() {
    let net = Net::new();
    let (a, b) = (net.device("a"), net.device("b"));
    // b moves the workspace to a new server first; a follows later.
    let moved = net.path().join("moved.git");
    bare(&moved);
    b.engine
        .switch_remote(&moved.to_string_lossy(), RemoteLayout::SharedBranch)
        .unwrap();
    b.ws.create_page_with_id("q", "After the move", None).unwrap();
    b.commit();
    assert!(b.sync().pushed);

    a.engine
        .switch_remote(&moved.to_string_lossy(), RemoteLayout::SharedBranch)
        .unwrap();
    a.sync();
    assert!(a.ws.page_exists("q"));
}

#[test]
fn a_folder_that_isnt_there_is_refused_then_reported_as_offline() {
    let net = Net::new();
    let a = net.device("a");
    let missing = net.path().join("Unplugged").join("Notes.docsync");
    let refused = a
        .engine
        .switch_remote(&missing.to_string_lossy(), folder_layout("a"));
    assert!(
        matches!(&refused, Err(Error::Network(reason)) if reason.contains("isn't there")),
        "{refused:?}"
    );

    // Set up while it was there, then the drive goes away.
    let folder = net.path().join("Drive").join("Notes.docsync");
    std::fs::create_dir_all(folder.parent().unwrap()).unwrap();
    SyncEngine::create_folder_remote(&real_git(), &folder).unwrap();
    a.engine
        .switch_remote(&folder.to_string_lossy(), folder_layout("a"))
        .unwrap();
    assert!(a.sync().pushed);
    let unplugged = folder.with_file_name("Unplugged.docsync");
    std::fs::rename(&folder, &unplugged).unwrap();
    let report = a.sync();
    assert!(report.offline, "{report:?}");
    assert!(report.offline_reason.unwrap().contains("isn't there"));

    // A folder that isn't a sync folder at all.
    let plain = net.path().join("Plain.docsync");
    std::fs::create_dir_all(&plain).unwrap();
    let refused = a
        .engine
        .switch_remote(&plain.to_string_lossy(), folder_layout("a"));
    assert!(matches!(refused, Err(Error::Network(_))), "{refused:?}");
}
