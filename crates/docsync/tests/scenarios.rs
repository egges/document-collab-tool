//! Concrete collaboration scenarios between simulated devices.

mod common;

use std::fs;
use std::time::{Duration, SystemTime};

use common::{Crash, Net, Op, assert_converged, assert_valid, settle};
use docsync::conflicts::find_conflicts;
use docsync::database::{ColumnChange, ColumnType};
use docsync::text_merge::{BLOCK_END, BLOCK_START};
use docsync::{Person, Resolution, Workspace};
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
            "intro\n{BLOCK_START}\n<!-- sync-conflict:version device=\"Desktop\" device-id=\"desktop-id\" -->\nthe desktop plan\n\
             <!-- sync-conflict:version device=\"Laptop\" device-id=\"laptop-id\" -->\nthe laptop plan\n{BLOCK_END}\noutro\n"
        )
    );
}

#[test]
fn a_conflict_block_names_the_person_and_the_device_of_each_version() {
    let net = Net::new();
    let laptop = net.device("Laptop");
    let page = laptop.ws.create_page("Plan", None).unwrap();
    laptop.ws.write_body(&page, &body(&["the plan"])).unwrap();
    laptop.sync();
    let desktop = net.device("Desktop");
    let person = |name: &str, id: &str| {
        Some(Person {
            name: name.to_string(),
            email: format!("{id}@example.com"),
            id: Some(id.to_string()),
        })
    };
    laptop.engine.set_person(person("Ada", "ada-id"));
    desktop.engine.set_person(person("Ben", "ben-id"));

    laptop.ws.write_body(&page, &body(&["Ada's plan"])).unwrap();
    laptop.commit();
    // Signing out or renaming the device afterwards doesn't change who
    // wrote what was already saved.
    laptop.engine.set_person(None);
    laptop.engine.set_device_name("Renamed");
    desktop.ws.write_body(&page, &body(&["Ben's plan"])).unwrap();
    desktop.sync();
    laptop.sync();
    settle(&[&laptop, &desktop]);

    let block = find_conflicts(&desktop.ws.read_body(&page).unwrap()).remove(0);
    // Ids tell people and devices apart even if their names are the same.
    let ids: Vec<_> = block
        .versions
        .iter()
        .map(|v| match &v.label {
            docsync::VersionLabel::By(w) => (w.person_id.clone(), w.device_id.clone()),
            other => panic!("{other:?}"),
        })
        .collect();
    let id = |s: &str| Some(s.to_string());
    assert_eq!(
        ids,
        [(id("ada-id"), id("laptop-id")), (id("ben-id"), id("desktop-id"))]
    );
    let labels: Vec<_> = block
        .versions
        .iter()
        .map(|v| (v.label.person(), v.label.device(), v.text.as_str()))
        .collect();
    assert_eq!(
        labels,
        [
            (Some("Ada"), Some("Laptop"), "Ada's plan\n"),
            (Some("Ben"), Some("Desktop"), "Ben's plan\n"),
        ]
    );

    // From now on the laptop writes under its new name, signed out.
    let resolved = laptop.engine.resolve_page_conflict(&page, 0, 0).unwrap();
    assert_eq!(resolved, body(&["Ada's plan"]));
    laptop.sync();
    desktop.sync();
    laptop.ws.write_body(&page, &body(&["the renamed plan"])).unwrap();
    desktop.ws.write_body(&page, &body(&["Ben's next plan"])).unwrap();
    desktop.sync();
    laptop.sync();
    let block = find_conflicts(&laptop.ws.read_body(&page).unwrap()).remove(0);
    assert_eq!(block.versions[0].label.to_string(), "Renamed");
    assert_eq!(block.versions[1].label.to_string(), "Ben (Desktop)");
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
    assert_eq!(meta["name"], "Renamed task");
}

#[test]
fn display_options_of_one_page_merge_and_reset() {
    let net = Net::new();
    let a = net.device("a");
    let page = a.ws.create_page("Wide notes", None).unwrap();
    a.sync();
    let b = net.device("b");
    a.ws.set_page_display(&page, "width", Some(json!("full")))
        .unwrap();
    b.ws.set_page_display(&page, "textSize", Some(json!("small")))
        .unwrap();
    a.sync();
    assert!(b.sync().conflicts.is_empty());
    settle(&[&a, &b]);
    let meta = a.ws.read_page_meta(&page).unwrap();
    assert_eq!(meta["display"], json!({"width": "full", "textSize": "small"}));

    // Back to the defaults: the field goes away.
    a.ws.set_page_display(&page, "width", None).unwrap();
    a.ws.set_page_display(&page, "textSize", None).unwrap();
    assert!(a.ws.read_page_meta(&page).unwrap().get("display").is_none());
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
fn renaming_the_workspace_reaches_every_device_and_the_newest_name_wins() {
    let net = Net::new();
    let a = net.device("a");
    assert_eq!(a.ws.name(), None);
    a.ws.set_name("  Team Notes ").unwrap();
    assert_eq!(a.ws.name().as_deref(), Some("Team Notes"));
    a.sync();
    let b = net.device("b");
    assert_eq!(b.ws.name().as_deref(), Some("Team Notes"));

    // Both rename; b does so 10 seconds later, and a page edit on a still
    // merges alongside.
    a.ws.set_name("Notes A").unwrap();
    let page = a.ws.create_page("Agenda", None).unwrap();
    a.commit();
    net.clock.advance(10);
    b.ws.set_name("Notes B").unwrap();
    b.commit();
    b.sync();
    a.sync();
    settle(&[&a, &b]);
    for device in [&a, &b] {
        assert_eq!(device.ws.name().as_deref(), Some("Notes B"));
        assert!(device.ws.page_exists(&page));
        assert_eq!(device.ws.read_page_meta(&page).unwrap()["name"], "Agenda");
    }
    assert!(a.ws.set_name("   ").is_err());
    assert_eq!(a.ws.name().as_deref(), Some("Notes B"));
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
        serde_json::Value::Object(a.ws.read_row(&db, &r1).unwrap().cells),
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
    // A row is a page: it comes back whole, text and all.
    assert_eq!(report.conflicts[0].resolution, Resolution::RestoredDeleted);
    settle(&[&a, &b]);
    assert_eq!(a.ws.read_row(&db, &row).unwrap().cells["name"], "y");
    assert!(a.ws.read_body(&row).is_ok());
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
    assert_converged(&[&a, &b]);
}

#[test]
fn deleting_a_database_while_a_row_is_edited_elsewhere_restores_every_row() {
    let net = Net::new();
    let a = net.device("a");
    let db = a.ws.create_database("Tasks", &["name"]).unwrap();
    let edited =
        a.ws.add_row(&db, json!({"name": "x"}).as_object().unwrap().clone())
            .unwrap();
    let untouched =
        a.ws.add_row(&db, json!({"name": "y"}).as_object().unwrap().clone())
            .unwrap();
    a.ws.write_body(&untouched, "Its text\n").unwrap();
    a.sync();
    let b = net.device("b");
    a.ws.delete_database(&db).unwrap();
    b.ws.set_cell(&db, &edited, "name", json!("x2")).unwrap();
    // Swap the order: the deleting device merges this time.
    b.sync();
    a.sync();
    settle(&[&a, &b]);
    for d in [&a, &b] {
        assert!(d.ws.database_exists(&db));
        assert_eq!(d.ws.read_row(&db, &edited).unwrap().cells["name"], "x2");
        assert_eq!(d.ws.read_body(&untouched).unwrap(), "Its text\n");
    }
    assert_converged(&[&a, &b]);
}

#[test]
fn deleting_a_database_while_an_unrelated_page_is_edited_deletes_its_rows() {
    let net = Net::new();
    let a = net.device("a");
    let db = a.ws.create_database("Tasks", &["name"]).unwrap();
    let row = a.ws.add_row(&db, Default::default()).unwrap();
    let page = a.ws.create_page("Notes", None).unwrap();
    a.sync();
    let b = net.device("b");
    a.ws.delete_database(&db).unwrap();
    b.ws.write_body(&page, "Edited\n").unwrap();
    a.sync();
    b.sync();
    settle(&[&a, &b]);
    for d in [&a, &b] {
        assert!(!d.ws.database_exists(&db));
        assert!(!d.ws.page_exists(&row));
    }
    assert_converged(&[&a, &b]);
}

#[test]
fn column_changes_on_different_devices_merge() {
    let net = Net::new();
    let a = net.device("a");
    let db = a.ws.create_database("Tasks", &["name", "status"]).unwrap();
    a.sync();
    let b = net.device("b");
    let due = a.ws.add_column(&db, "Due", ColumnType::Date).unwrap();
    let owner = b.ws.add_column(&db, "Owner", ColumnType::Text).unwrap();
    b.ws.update_column(
        &db,
        "status",
        &ColumnChange {
            name: Some("Status".into()),
            kind: Some(ColumnType::Select),
            options: Some(vec!["Todo".into(), "Done".into()]),
            ..Default::default()
        },
    )
    .unwrap();
    a.ws.update_column(
        &db,
        "name",
        &ColumnChange {
            name: Some("Title".into()),
            ..Default::default()
        },
    )
    .unwrap();
    a.sync();
    assert!(b.sync().conflicts.is_empty());
    settle(&[&a, &b]);
    let schema = a.ws.read_schema(&db).unwrap();
    let names: Vec<&str> = schema.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names[..3], ["Name", "Title", "Status"]);
    assert_eq!(schema.column("status").unwrap().kind, ColumnType::Select);
    assert!(schema.column(&due).is_some() && schema.column(&owner).is_some());
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
    assert_eq!(a.ws.read_page_meta(&page).unwrap()["name"], "New title");
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
        assert!(report.offline_reason.is_some());
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
            "{{\n  \"id\": \"{page}\",\n  \"name\": \"Readme\",\n  \"parent\": null,\n  \"properties\": {{\n    \"tags\": [\n      \"x\"\n    ]\n  }}\n}}\n"
        )
    );
    assert_eq!(a.file(&format!("pages/{page}/page.md")).unwrap(), "# Hello\n");
    assert_valid(&a);
    let _ = Workspace::new(a.root());
}

#[test]
fn commits_are_by_the_person_and_made_on_the_device() {
    let net = Net::new();
    let a = net.device("laptop");
    a.engine.set_person(Some(Person {
        name: "Ada Lovelace".into(),
        email: "1+ada@users.noreply.github.com".into(),
        id: Some("3f9a1c2b5e6d7f80".into()),
    }));
    let page = a.ws.create_page("Signed in", None).unwrap();
    a.ws.write_body(&page, "hello\n").unwrap();
    a.commit();
    let out = common::git_command()
        .arg("-C")
        .arg(a.root())
        .args([
            "log",
            "-1",
            "--format=%an <%ae>|%cn <%ce>|%(trailers:key=Person-Id,valueonly)",
        ])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8(out.stdout).unwrap().trim(),
        "Ada Lovelace <1+ada@users.noreply.github.com>|laptop <laptop+laptop-id@devices.invalid>|3f9a1c2b5e6d7f80"
    );
}

#[test]
fn two_devices_moving_the_same_front_matter_converge_without_conflicts() {
    let net = Net::new();
    let a = net.device("a");
    let page = a.ws.create_page("", None).unwrap();
    a.ws.write_body(&page, "---\ntitle: From a tool\ntags: [x]\n---\n\nText\n")
        .unwrap();
    a.sync();
    let b = net.device("b");
    assert!(a.ws.lift_front_matter(&page).unwrap());
    assert!(b.ws.lift_front_matter(&page).unwrap());
    assert!(!b.ws.lift_front_matter(&page).unwrap(), "only moved once");
    a.sync();
    let report = b.sync();
    assert!(report.conflicts.is_empty(), "{report:?}");
    settle(&[&a, &b]);
    assert_converged(&[&a, &b]);
    let meta = a.ws.read_page_meta(&page).unwrap();
    assert_eq!(meta["name"], json!("From a tool"));
    assert_eq!(meta["properties"], json!({"tags": ["x"]}));
    assert_eq!(a.ws.read_body(&page).unwrap(), "Text\n");
}

#[test]
fn view_changes_on_a_database_page_merge_across_devices() {
    use docsync::database_page::{DatabasePage, Sort, View, ViewType};
    let net = Net::new();
    let a = net.device("a");
    let db = a.ws.create_database("Tasks", &["name", "status"]).unwrap();
    let page = a.ws.create_database_page("Tasks", None, Some(&db)).unwrap();
    a.sync();
    let b = net.device("b");
    let read = |ws: &Workspace| DatabasePage::from_meta(&ws.read_page_meta(&page).unwrap()).unwrap();
    let table = read(&a.ws).views[0].clone();

    // A sorts the table; B adds a board. Different fields: both kept.
    let mut sorted = table.clone();
    sorted.sort = Some(Sort {
        column: "name".into(),
        descending: false,
    });
    a.ws.set_page_view(&page, &table.id, Some(&sorted)).unwrap();
    let mut board = View::new("board1", "Board", ViewType::Board, 1.0);
    board.group_by = Some("status".into());
    b.ws.set_page_view(&page, &board.id, Some(&board)).unwrap();
    b.ws.set_title(&page, "Sprint").unwrap();
    a.sync();
    assert!(b.sync().conflicts.is_empty());
    settle(&[&a, &b]);

    let merged = read(&a.ws);
    assert_eq!(merged.database.as_deref(), Some(db.as_str()));
    assert_eq!(merged.views.len(), 2);
    assert_eq!(merged.views[0].sort, sorted.sort);
    assert_eq!(merged.views[1].group_by.as_deref(), Some("status"));
    assert_eq!(a.ws.pages_showing(&db).unwrap(), [page.as_str()]);
    assert_converged(&[&a, &b]);
}

#[test]
fn deleting_a_database_while_a_row_page_is_written_elsewhere_restores_the_database() {
    let net = Net::new();
    let a = net.device("a");
    let db = a.ws.create_database("Tasks", &["name"]).unwrap();
    let row = a.ws.add_row(&db, Default::default()).unwrap();
    a.sync();
    let b = net.device("b");
    a.ws.delete_database(&db).unwrap();
    b.ws.write_body(&row, "Written while it was deleted\n").unwrap();
    a.sync();
    b.sync();
    settle(&[&a, &b]);
    assert!(a.ws.database_exists(&db));
    assert_eq!(a.ws.read_body(&row).unwrap(), "Written while it was deleted\n");
    assert_converged(&[&a, &b]);
}

#[test]
fn page_properties_added_on_two_devices_merge() {
    let net = Net::new();
    let a = net.device("a");
    let page = a.ws.create_page("Trip", None).unwrap();
    a.sync();
    let b = net.device("b");
    let when = a.ws.add_page_property(&page, "When", ColumnType::Date).unwrap();
    a.ws.set_page_property(&page, &when, json!("2026-12-01")).unwrap();
    let done =
        b.ws.add_page_property(&page, "Booked", ColumnType::Checkbox)
            .unwrap();
    b.ws.set_page_property(&page, &done, json!(true)).unwrap();
    a.sync();
    assert!(b.sync().conflicts.is_empty());
    settle(&[&a, &b]);
    let (columns, values) = a.ws.page_properties(&page).unwrap();
    assert_eq!(columns.len(), 2);
    assert_eq!(values[&when], "2026-12-01");
    assert_eq!(values[&done], true);
}
