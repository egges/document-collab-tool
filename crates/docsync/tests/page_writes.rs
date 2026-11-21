//! Writing pages from the editor while sync changes them underneath, and
//! resolving the conflict blocks that leaves.

mod common;

use common::{Net, assert_valid, settle};
use docsync::conflicts::{ResolveError, find_conflicts};
use docsync::{Error, OTHER_CHANGES_LABEL, PageWrite};

#[test]
fn writes_as_given_when_the_page_did_not_change_on_disk() {
    let net = Net::new();
    let a = net.device("laptop");
    let page = a.ws.create_page("Notes", None).unwrap();
    a.ws.write_body(&page, "one\n").unwrap();

    let write = a.engine.write_page_body(&page, "one\n", "one\ntwo\n").unwrap();
    assert_eq!(write, PageWrite::Written);
    assert_eq!(a.ws.read_body(&page).unwrap(), "one\ntwo\n");
}

#[test]
fn merges_with_what_sync_pulled_in_meanwhile() {
    let net = Net::new();
    let a = net.device("laptop");
    let page = a.ws.create_page("Notes", None).unwrap();
    a.ws.write_body(&page, "first\n\nmiddle\n\nlast\n").unwrap();
    a.sync();
    let b = net.device("desktop");

    // The laptop's editor opened the page, then sync pulled the desktop's edit.
    let base = a.ws.read_body(&page).unwrap();
    b.ws.write_body(&page, "first\n\nmiddle\n\nlast, from the desktop\n")
        .unwrap();
    b.sync();
    a.sync();

    let write = a
        .engine
        .write_page_body(&page, &base, "first, from the laptop\n\nmiddle\n\nlast\n")
        .unwrap();
    let merged = "first, from the laptop\n\nmiddle\n\nlast, from the desktop\n";
    assert_eq!(
        write,
        PageWrite::Merged {
            body: merged.into(),
            conflicts: 0
        }
    );
    assert_eq!(a.ws.read_body(&page).unwrap(), merged);
    settle(&[&a, &b]);
}

#[test]
fn overlapping_edits_become_a_conflict_block_that_both_devices_can_resolve() {
    let net = Net::new();
    let a = net.device("laptop");
    let page = a.ws.create_page("Notes", None).unwrap();
    a.ws.write_body(&page, "intro\n\nthe plan\n\noutro\n").unwrap();
    a.sync();
    let b = net.device("desktop");

    let base = a.ws.read_body(&page).unwrap();
    // An AI agent rewrote the same line on disk while the user was typing.
    a.ws.write_body(&page, "intro\n\nthe agent's plan\n\noutro\n")
        .unwrap();
    let write = a
        .engine
        .write_page_body(&page, &base, "intro\n\nthe user's plan\n\noutro\n")
        .unwrap();
    let PageWrite::Merged { body, conflicts: 1 } = write else {
        panic!("expected one conflict, got {write:?}");
    };
    let blocks = find_conflicts(&body);
    assert_eq!(blocks.len(), 1);
    let labels: Vec<_> = blocks[0].versions.iter().map(|v| v.label.as_str()).collect();
    assert_eq!(labels, ["laptop", OTHER_CHANGES_LABEL]);
    assert_valid(&a);

    // The block syncs like any other text, and the desktop resolves it.
    settle(&[&a, &b]);
    let resolved = b.engine.resolve_page_conflict(&page, 0, 1).unwrap();
    assert_eq!(resolved, "intro\n\nthe agent's plan\n\noutro\n");
    settle(&[&a, &b]);
    assert_eq!(a.ws.read_body(&page).unwrap(), resolved);

    // Resolving again finds nothing to resolve.
    assert!(matches!(
        a.engine.resolve_page_conflict(&page, 0, 0),
        Err(Error::Resolve(ResolveError::NoSuchBlock { index: 0, count: 0 }))
    ));
}

#[test]
fn does_not_recreate_a_page_that_sync_deleted() {
    let net = Net::new();
    let a = net.device("laptop");
    let page = a.ws.create_page("Doomed", None).unwrap();
    a.ws.write_body(&page, "text\n").unwrap();
    a.sync();
    let b = net.device("desktop");
    b.ws.delete_page(&page).unwrap();
    b.sync();
    a.sync();

    assert!(!a.ws.page_exists(&page));
    let write = a
        .engine
        .write_page_body(&page, "text\n", "text, edited\n")
        .unwrap();
    assert_eq!(write, PageWrite::PageGone);
    assert!(!a.root().join("pages").join(&page).join("page.md").exists());
}
