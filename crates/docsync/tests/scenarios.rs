//! Concrete collaboration scenarios between simulated devices.

mod common;

use std::fs;
use std::time::{Duration, SystemTime};

use common::{Crash, Net, Op, assert_converged, assert_valid, settle};
use docsync::text_merge::{BLOCK_END, BLOCK_START};
use docsync::{Resolution, Workspace};
use serde_json::json;

fn body(lines: &[&str]) -> String {
    lines.iter().map(|l| format!("{l}\n")).collect()
}

#[test]
fn first_device_publishes_and_second_device_joins() {
    let net = Net::new();
    let laptop = net.device("laptop");
    let page = laptop.ws.create_page("Welcome", None).unwrap();
    laptop.ws.write_body(&page, "Hello\n").unwrap();
    assert!(laptop.sync().pushed);

    let desktop = net.device("desktop");
    assert_eq!(desktop.ws.read_body(&page).unwrap(), "Hello\n");
    assert_converged(&[&laptop, &desktop]);
}

#[test]
fn two_devices_creating_workspaces_on_an_empty_remote_converge() {
    let net = Net::new();
    let a = net.device_unsynced("a");
    let b = net.device_unsynced("b");
    let pa = a.ws.create_page("From A", None).unwrap();
    let pb = b.ws.create_page("From B", None).unwrap();
    a.sync();
    let report = b.sync();
    assert!(report.merged && report.conflicts.is_empty(), "{report:?}");
    settle(&[&a, &b]);
    assert!(a.ws.page_exists(&pb) && b.ws.page_exists(&pa));
}

#[test]
fn edits_to_different_pages_merge() {
    let net = Net::new();
    let (a, b) = (net.device("a"), net.device("b"));
    let pa = a.ws.create_page("A", None).unwrap();
    let pb = b.ws.create_page("B", None).unwrap();
    a.sync();
    let report = b.sync();
    assert!(report.merged && report.pushed && report.conflicts.is_empty());
    settle(&[&a, &b]);
    assert!(a.ws.page_exists(&pb) && b.ws.page_exists(&pa));
}

#[test]
fn edits_to_different_paragraphs_of_one_page_merge_cleanly() {
    let net = Net::new();
    let a = net.device("a");
    let page = a.ws.create_page("Notes", None).unwrap();
    a.ws.write_body(&page, &body(&["# Notes", "", "first", "", "middle", "", "last"]))
        .unwrap();
    a.sync();
    let b = net.device("b");

    a.ws.write_body(
        &page,
        &body(&["# Notes", "", "first (edited on a)", "", "middle", "", "last"]),
    )
    .unwrap();
    b.ws.write_body(
        &page,
        &body(&["# Notes", "", "first", "", "middle", "", "last (edited on b)"]),
    )
    .unwrap();
    a.sync();
    let report = b.sync();
    assert!(report.conflicts.is_empty(), "{report:?}");
    settle(&[&a, &b]);
    assert_eq!(
        a.ws.read_body(&page).unwrap(),
        body(&[
            "# Notes",
            "",
            "first (edited on a)",
            "",
            "middle",
            "",
            "last (edited on b)"
        ])
    );
}

#[test]
fn overlapping_edits_keep_both_versions_in_a_conflict_block() {
    let net = Net::new();
    let laptop = net.device("Laptop");
    let page = laptop.ws.create_page("Plan", None).unwrap();
    laptop
        .ws
        .write_body(&page, &body(&["intro", "the plan", "outro"]))
        .unwrap();
    laptop.sync();
    let desktop = net.device("Desktop");

    laptop
        .ws
        .write_body(&page, &body(&["intro", "the laptop plan", "outro"]))
        .unwrap();
    desktop
        .ws
        .write_body(&page, &body(&["intro", "the desktop plan", "outro"]))
        .unwrap();
    laptop.sync();
    let report = desktop.sync();
    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(report.conflicts[0].resolution, Resolution::KeptBothVersions);
    settle(&[&laptop, &desktop]);

    let text = laptop.ws.read_body(&page).unwrap();
    assert_eq!(
        text,
        format!(
            "intro\n{BLOCK_START}\n<!-- sync-conflict:version Desktop -->\nthe desktop plan\n\
             <!-- sync-conflict:version Laptop -->\nthe laptop plan\n{BLOCK_END}\noutro\n"
        )
    );
}

#[test]
fn both_devices_appending_to_a_page_keeps_both_additions() {
    let net = Net::new();
    let a = net.device("a");
    let page = a.ws.create_page("Log", None).unwrap();
    a.ws.write_body(&page, "start\n").unwrap();
    a.sync();
    let b = net.device("b");
    a.ws.write_body(&page, "start\nfrom a\n").unwrap();
    b.ws.write_body(&page, "start\nfrom b\n").unwrap();
    a.sync();
    b.sync();
    settle(&[&a, &b]);
    let text = a.ws.read_body(&page).unwrap();
    assert!(text.contains("from a\n") && text.contains("from b\n"), "{text}");
}

#[test]
fn different_properties_of_one_page_merge() {
    let net = Net::new();
    let a = net.device("a");
    let page = a.ws.create_page("Task", None).unwrap();
    a.sync();
    let b = net.device("b");
    a.ws.set_page_property(&page, "status", json!("doing")).unwrap();
    b.ws.set_page_property(&page, "owner", json!("sam")).unwrap();
    b.ws.set_title(&page, "Renamed task").unwrap();
    a.sync();
    assert!(b.sync().conflicts.is_empty());
    settle(&[&a, &b]);
    let meta = a.ws.read_page_meta(&page).unwrap();
    assert_eq!(meta["properties"], json!({"status": "doing", "owner": "sam"}));
    assert_eq!(meta["title"], "Renamed task");
}

#[test]
fn same_property_most_recent_edit_wins_regardless_of_sync_order() {
    for later_device_syncs_first in [false, true] {
        let net = Net::new();
        let a = net.device("a");
        let page = a.ws.create_page("Task", None).unwrap();
        a.ws.set_page_property(&page, "status", json!("todo")).unwrap();
        a.sync();
        let b = net.device("b");

        // a edits first, b edits 10 seconds later.
        a.ws.set_page_property(&page, "status", json!("doing")).unwrap();
        a.commit();
        net.clock.advance(10);
        b.ws.set_page_property(&page, "status", json!("done")).unwrap();
        b.commit();
        net.clock.advance(10);

        if later_device_syncs_first {
            b.sync();
            let report = a.sync();
            assert_eq!(
                report.conflicts[0].resolution,
                Resolution::NewestFieldsWon {
                    fields: vec!["properties.status".into()]
                }
            );
        } else {
            a.sync();
            b.sync();
        }
        settle(&[&a, &b]);
        assert_eq!(
            a.ws.read_page_meta(&page).unwrap()["properties"]["status"],
            "done"
        );
    }
}

#[test]
fn same_property_edited_at_the_same_second_goes_to_the_remote_version() {
    let net = Net::new();
    let a = net.device("a");
    let page = a.ws.create_page("Task", None).unwrap();
    a.sync();
    let b = net.device("b");
    a.ws.set_page_property(&page, "status", json!("a")).unwrap();
    b.ws.set_page_property(&page, "status", json!("b")).unwrap();
    a.sync();
    b.sync(); // b merges; a's version is already published, so it wins.
    settle(&[&a, &b]);
    assert_eq!(a.ws.read_page_meta(&page).unwrap()["properties"]["status"], "a");
}

#[test]
fn property_removed_on_one_device_and_changed_on_another_keeps_the_change() {
    let net = Net::new();
    let a = net.device("a");
    let page = a.ws.create_page("Task", None).unwrap();
    a.ws.set_page_property(&page, "due", json!("monday")).unwrap();
    a.sync();
    let b = net.device("b");

    let meta_path = a.root().join("pages").join(&page).join("meta.json");
    let mut meta = a.ws.read_page_meta(&page).unwrap();
    meta["properties"].as_object_mut().unwrap().remove("due");
    fs::write(&meta_path, docsync::json_merge::to_canonical_bytes(&meta)).unwrap();
    b.ws.set_page_property(&page, "due", json!("friday")).unwrap();
    a.sync();
    b.sync();
    settle(&[&a, &b]);
    assert_eq!(a.ws.read_page_meta(&page).unwrap()["properties"]["due"], "friday");
}

#[test]
fn deleting_a_page_that_was_edited_elsewhere_restores_it() {
    for deleter_syncs_first in [true, false] {
        let net = Net::new();
        let a = net.device("a");
        let page = a.ws.create_page("Doc", None).unwrap();
        a.ws.write_body(&page, "v1\n").unwrap();
        a.sync();
        let b = net.device("b");

        a.ws.delete_page(&page).unwrap();
        b.ws.write_body(&page, "v2\n").unwrap();
        let reports = if deleter_syncs_first {
            [a.sync(), b.sync()]
        } else {
            [b.sync(), a.sync()]
        };
        assert!(
            reports[1]
                .conflicts
                .iter()
                .any(|c| c.resolution == Resolution::RestoredDeleted),
            "{reports:?}"
        );
        settle(&[&a, &b]);
        assert_eq!(a.ws.read_body(&page).unwrap(), "v2\n");
        assert!(a.ws.read_page_meta(&page).is_ok(), "meta.json must come back too");
    }
}

#[test]
fn deleting_a_page_nobody_else_touched_deletes_it_everywhere() {
    let net = Net::new();
    let a = net.device("a");
    let page = a.ws.create_page("Doc", None).unwrap();
    let other = a.ws.create_page("Other", None).unwrap();
    a.sync();
    let b = net.device("b");
    a.ws.delete_page(&page).unwrap();
    b.ws.write_body(&other, "unrelated\n").unwrap();
    a.sync();
    b.sync();
    settle(&[&a, &b]);
    assert!(!b.ws.page_exists(&page));
}

#[test]
fn rows_edited_on_different_devices_merge() {
    let net = Net::new();
    let a = net.device("a");
    let db = a.ws.create_database("Tasks", &["name", "status"]).unwrap();
    let r1 =
        a.ws.add_row(&db, json!({"name": "one"}).as_object().unwrap().clone())
            .unwrap();
    a.sync();
    let b = net.device("b");
    a.ws.set_cell(&db, &r1, "status", json!("done")).unwrap();
    let r2 =
        b.ws.add_row(&db, json!({"name": "two"}).as_object().unwrap().clone())
            .unwrap();
    b.ws.set_cell(&db, &r1, "name", json!("one (renamed)")).unwrap();
    a.sync();
    assert!(b.sync().conflicts.is_empty());
    settle(&[&a, &b]);
    assert_eq!(
        a.ws.read_row(&db, &r1).unwrap()["cells"],
        json!({"name": "one (renamed)", "status": "done"})
    );
    assert!(a.ws.row_exists(&db, &r2));
}

#[test]
fn deleting_a_row_that_was_edited_elsewhere_keeps_the_row() {
    let net = Net::new();
    let a = net.device("a");
    let db = a.ws.create_database("Tasks", &["name"]).unwrap();
    let row =
        a.ws.add_row(&db, json!({"name": "x"}).as_object().unwrap().clone())
            .unwrap();
    a.sync();
    let b = net.device("b");
    a.ws.delete_row(&db, &row).unwrap();
    b.ws.set_cell(&db, &row, "name", json!("y")).unwrap();
    a.sync();
    let report = b.sync();
    assert_eq!(report.conflicts[0].resolution, Resolution::KeptEditOverDelete);
    settle(&[&a, &b]);
    assert_eq!(a.ws.read_row(&db, &row).unwrap()["cells"]["name"], "y");
}

#[test]
fn deleting_a_database_while_a_row_is_added_elsewhere_restores_the_database() {
    let net = Net::new();
    let a = net.device("a");
    let db = a.ws.create_database("Tasks", &["name"]).unwrap();
    let r1 =
        a.ws.add_row(&db, json!({"name": "x"}).as_object().unwrap().clone())
            .unwrap();
    a.sync();
    let b = net.device("b");
    a.ws.delete_database(&db).unwrap();
    let r2 =
        b.ws.add_row(&db, json!({"name": "new"}).as_object().unwrap().clone())
            .unwrap();
    a.sync();
    b.sync();
    settle(&[&a, &b]);
    assert!(
        a.ws.database_exists(&db),
        "schema must come back with the new row"
    );
    assert!(a.ws.row_exists(&db, &r1) && a.ws.row_exists(&db, &r2));
}

#[test]
fn binary_attachment_changed_on_both_devices_keeps_a_copy() {
    let net = Net::new();
    let a = net.device("a");
    let page = a.ws.create_page("Pics", None).unwrap();
    let asset = format!("pages/{page}/assets/photo.png");
    fs::create_dir_all(a.root().join(format!("pages/{page}/assets"))).unwrap();
    fs::write(a.root().join(&asset), [0u8, 1, 2]).unwrap();
    a.sync();
    let b = net.device("b");
    fs::write(a.root().join(&asset), [0u8, 1, 2, 3]).unwrap();
    a.commit();
    net.clock.advance(5);
    fs::write(b.root().join(&asset), [9u8, 9]).unwrap();
    b.commit();
    a.sync();
    let report = b.sync();
    let Resolution::KeptNewestWithCopy { copy } = &report.conflicts[0].resolution else {
        panic!("{report:?}")
    };
    settle(&[&a, &b]);
    assert_eq!(
        fs::read(a.root().join(&asset)).unwrap(),
        vec![9u8, 9],
        "b's edit is newer"
    );
    assert_eq!(fs::read(a.root().join(copy)).unwrap(), vec![0u8, 1, 2, 3]);
    assert!(copy.contains(".conflict-a-"), "{copy}");
}

#[test]
fn hand_edited_invalid_json_does_not_break_sync() {
    let net = Net::new();
    let a = net.device("a");
    let page = a.ws.create_page("Doc", None).unwrap();
    a.sync();
    let b = net.device("b");
    let rel = format!("pages/{page}/meta.json");
    fs::write(a.root().join(&rel), "{ not json").unwrap();
    b.ws.set_title(&page, "New title").unwrap();
    a.sync();
    b.sync();
    settle(&[&a, &b]);
    // The valid version wins, even though a's edit was published first.
    assert_eq!(a.ws.read_page_meta(&page).unwrap()["title"], "New title");
    let copy = format!("pages/{page}/meta.conflict-a-");
    let broken = a
        .files()
        .into_iter()
        .find(|(p, _)| p.starts_with(&copy))
        .expect("copy kept");
    assert_eq!(broken.1, b"{ not json");
}

#[test]
fn offline_device_keeps_working_and_catches_up() {
    let net = Net::new();
    let (a, b) = (net.device("a"), net.device("b"));
    b.faults.set_offline(true);
    let mut pages = Vec::new();
    for i in 0..3 {
        let p = b.ws.create_page(&format!("offline {i}"), None).unwrap();
        b.ws.write_body(&p, &format!("written offline {i}\n")).unwrap();
        let report = b.sync();
        assert!(report.offline && report.committed && !report.pushed);
        pages.push(p);
    }
    let online = a.ws.create_page("online", None).unwrap();
    a.sync();

    b.faults.set_offline(false);
    let report = b.sync();
    assert!(report.merged && report.pushed);
    settle(&[&a, &b]);
    assert!(a.ws.page_exists(&online));
    for p in &pages {
        assert!(a.ws.page_exists(p));
    }
}

#[test]
fn push_race_is_retried() {
    let net = Net::new();
    let (a, b) = (net.device("a"), net.device("b"));
    let pa = a.ws.create_page("A", None).unwrap();
    let pb = b.ws.create_page("B", None).unwrap();
    b.commit();

    // Right before a pushes, b publishes its own change.
    let b_root = b.root().to_path_buf();
    let url = net.url();
    a.faults.before_next(Op::Push, move || {
        let out = common::git_command()
            .arg("-C")
            .arg(&b_root)
            .args(["push", "-q", &url, "HEAD:refs/heads/main"])
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    });
    let report = a.sync();
    assert!(report.pushed && report.merged, "{report:?}");
    settle(&[&a, &b]);
    assert!(b.ws.page_exists(&pa) && a.ws.page_exists(&pb));
}

#[test]
fn edits_made_while_a_sync_is_running_are_not_lost() {
    let net = Net::new();
    let a = net.device("a");
    let page = a.ws.create_page("Doc", None).unwrap();
    a.ws.write_body(&page, "one\n").unwrap();
    a.sync();
    let b = net.device("b");
    b.ws.write_body(&page, "one\nfrom b\n").unwrap();
    b.sync();

    // The user types into the same page between commit and checkout.
    let ws = a.ws.clone();
    let p = page.clone();
    a.faults.before_next(Op::Checkout, move || {
        ws.write_body(&p, "typed during sync\none\n").unwrap();
    });
    a.sync();
    settle(&[&a, &b]);
    let text = a.ws.read_body(&page).unwrap();
    assert!(
        text.contains("typed during sync") && text.contains("from b"),
        "{text}"
    );
}

#[test]
fn stale_lock_files_from_a_crashed_git_are_removed() {
    let net = Net::new();
    let a = net.device("a");
    let lock = a.root().join(".git/index.lock");
    fs::write(&lock, "").unwrap();
    let old = SystemTime::now() - Duration::from_secs(3600);
    fs::File::options()
        .write(true)
        .open(&lock)
        .unwrap()
        .set_modified(old)
        .unwrap();
    a.ws.create_page("after crash", None).unwrap();
    let report = a.sync();
    assert_eq!(report.removed_locks, vec!["index.lock".to_string()]);
    assert!(report.pushed);
}

#[test]
fn reopening_a_workspace_after_a_crash_resumes_syncing() {
    let net = Net::new();
    let (a, b) = (net.device("a"), net.device("b"));
    let page = a.ws.create_page("Doc", None).unwrap();
    a.faults.crash_at(0, Crash::Before);
    let _ = a.engine.sync();
    assert!(a.faults.disarm());
    let a = net.reopen(a);
    a.sync();
    settle(&[&a, &b]);
    assert!(b.ws.page_exists(&page));
}

#[test]
fn files_are_plain_and_readable_without_the_app() {
    let net = Net::new();
    let a = net.device("a");
    let page = a.ws.create_page("Readme", None).unwrap();
    a.ws.write_body(&page, "# Hello\n").unwrap();
    a.ws.set_page_property(&page, "tags", json!(["x"])).unwrap();
    a.sync();
    let meta = a.file(&format!("pages/{page}/meta.json")).unwrap();
    assert_eq!(
        meta,
        format!(
            "{{\n  \"id\": \"{page}\",\n  \"parent\": null,\n  \"properties\": {{\n    \"tags\": [\n      \"x\"\n    ]\n  }},\n  \"title\": \"Readme\"\n}}\n"
        )
    );
    assert_eq!(a.file(&format!("pages/{page}/page.md")).unwrap(), "# Hello\n");
    assert_valid(&a);
    let _ = Workspace::new(a.root());
}
