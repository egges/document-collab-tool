//! Syncing through a cloud folder (Dropbox, iCloud Drive, ...): a bare
//! repository that the service copies file by file, in any order. Each
//! device writes only its own ref; see "Cloud folder remotes" in
//! docs/sync-design.md.

mod common;

use common::Net;

fn is_ref(path: &str) -> bool {
    path.starts_with("refs/")
}

#[test]
fn devices_sync_through_a_cloud_folder() {
    let net = Net::folder();
    let laptop = net.device("laptop");
    laptop
        .ws
        .create_page_with_id("a", "From the laptop", None)
        .unwrap();
    laptop.commit();
    assert!(laptop.sync().pushed);

    let desktop = net.device("desktop");
    assert_eq!(desktop.ws.read_page_meta("a").unwrap()["name"], "From the laptop");
    desktop
        .ws
        .create_page_with_id("b", "From the desktop", None)
        .unwrap();
    desktop.commit();
    laptop
        .ws
        .create_page_with_id("c", "Also from the laptop", None)
        .unwrap();
    laptop.commit();

    net.settle(&[&laptop, &desktop]);
    for page in ["a", "b", "c"] {
        assert!(laptop.ws.page_exists(page), "{page}");
    }
}

#[test]
fn each_device_writes_only_its_own_ref() {
    let net = Net::folder();
    let (a, b) = (net.device("a"), net.device("b"));
    a.ws.create_page_with_id("p", "A", None).unwrap();
    a.commit();
    b.ws.create_page_with_id("q", "B", None).unwrap();
    b.commit();
    // Both publish before seeing each other: the cloud would make a
    // conflicted copy of any file they both wrote (and fail the test).
    a.sync();
    b.sync();
    net.settle(&[&a, &b]);
    let refs = common::git_command()
        .args(["for-each-ref", "--format=%(refname)"])
        .current_dir(&net.remote)
        .output()
        .unwrap();
    let refs = String::from_utf8_lossy(&refs.stdout);
    assert_eq!(
        refs.lines().collect::<Vec<_>>(),
        ["refs/heads/devices/a", "refs/heads/devices/b"]
    );
}

#[test]
fn a_ref_that_arrives_before_its_objects_waits_for_them() {
    let net = Net::folder();
    let (a, b) = (net.device("a"), net.device("b"));
    let cloud = net.cloud.as_ref().unwrap();
    a.ws.create_page_with_id("p", "Written on a", None).unwrap();
    a.commit();
    a.sync();
    // b's copy of the folder gets a's new ref, but not the pack it needs.
    cloud.transfer(|copy, path, upload| upload && copy == "a" || copy == "b" && is_ref(path));

    b.ws.create_page_with_id("q", "Written on b", None).unwrap();
    b.commit();
    let report = b.sync();
    assert_eq!(report.incomplete_devices, ["a"]);
    assert!(!report.offline, "{report:?}");
    // git's own push would refuse here, since a's ref points at objects
    // that aren't there.
    assert!(report.pushed, "{report:?}");
    assert!(!b.ws.page_exists("p"));

    net.settle(&[&a, &b]);
    assert!(b.ws.page_exists("p") && a.ws.page_exists("q"));
}

#[test]
fn conflicting_edits_resolve_like_any_other_remote() {
    let net = Net::folder();
    let (a, b) = (net.device("a"), net.device("b"));
    a.ws.create_page_with_id("p", "Start", None).unwrap();
    a.commit();
    net.settle(&[&a, &b]);

    a.ws.write_body("p", "one\nfrom a\nthree\n").unwrap();
    a.commit();
    net.clock.advance(5);
    b.ws.write_body("p", "one\nfrom b\nthree\n").unwrap();
    b.commit();
    net.settle(&[&a, &b]);
    let body = a.ws.read_body("p").unwrap();
    assert!(body.contains("from a") && body.contains("from b"), "{body}");
}

#[test]
fn a_missing_folder_is_like_being_offline() {
    let net = Net::folder();
    let a = net.device("a");
    let copy = a.engine.root().parent().unwrap().join("a-cloud");
    let moved = copy.with_file_name("a-cloud-unmounted");
    std::fs::rename(&copy, &moved).unwrap();
    a.ws.create_page_with_id("p", "Offline", None).unwrap();
    a.commit();
    let report = a.sync();
    assert!(report.offline && !report.pushed, "{report:?}");

    std::fs::rename(&moved, &copy).unwrap();
    assert!(a.sync().pushed);
}
