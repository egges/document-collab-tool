//! Crash a sync at every git call, restart, and check nothing was lost.
//!
//! The scenario covers each merge path at once: overlapping text edits, a
//! clean text merge, different and identical JSON fields, delete-vs-edit and
//! new pages on both sides. The crash is injected both just before and just
//! after each call, which models the process dying with the call either not
//! started or fully completed (including a push that reached the remote).

mod common;

use common::{Crash, Device, Net, settle};
use serde_json::json;

struct Scenario {
    net: Net,
    a: Device,
    b: Device,
    shared: String,
    task: String,
    deleted_by_a: String,
    new_on_a: String,
    new_on_b: String,
}

fn setup() -> Scenario {
    let net = Net::new();
    let a = net.device("a");
    let shared = a.ws.create_page("Shared", None).unwrap();
    a.ws.write_body(&shared, "top\n\nmiddle\n\nbottom\n").unwrap();
    let task = a.ws.create_page("Task", None).unwrap();
    let deleted_by_a = a.ws.create_page("Doomed", None).unwrap();
    a.ws.write_body(&deleted_by_a, "v1\n").unwrap();
    a.sync();
    let b = net.device("b");

    a.ws.write_body(&shared, "top (a)\n\nmiddle (a)\n\nbottom\n")
        .unwrap();
    a.ws.set_page_property(&task, "status", json!("doing")).unwrap();
    a.ws.delete_page(&deleted_by_a).unwrap();
    let new_on_a = a.ws.create_page("New on a", None).unwrap();
    a.commit();

    net.clock.advance(1);
    b.ws.write_body(&shared, "top\n\nmiddle (b)\n\nbottom (b)\n")
        .unwrap();
    b.ws.set_page_property(&task, "owner", json!("b")).unwrap();
    b.ws.write_body(&deleted_by_a, "v2 from b\n").unwrap();
    let new_on_b = b.ws.create_page("New on b", None).unwrap();
    b.sync();

    Scenario {
        net,
        a,
        b,
        shared,
        task,
        deleted_by_a,
        new_on_a,
        new_on_b,
    }
}

fn check_outcome(s: &Scenario) {
    let ws = &s.a.ws;
    let body = ws.read_body(&s.shared).unwrap();
    for expected in ["top (a)", "middle (a)", "middle (b)", "bottom (b)"] {
        assert!(body.contains(expected), "missing {expected:?} in:\n{body}");
    }
    let props = &ws.read_page_meta(&s.task).unwrap()["properties"];
    assert_eq!(props, &json!({"status": "doing", "owner": "b"}));
    assert_eq!(ws.read_body(&s.deleted_by_a).unwrap(), "v2 from b\n");
    assert!(ws.page_exists(&s.new_on_a) && ws.page_exists(&s.new_on_b));
}

/// Crash sync call number `nth`, restart, settle and check the outcome.
/// Returns whether the crash fired (false once `nth` is past the last call).
fn run_case(nth: usize, when: Crash) -> bool {
    let s = setup();
    s.a.faults.crash_at(nth, when);
    let result = s.a.engine.sync();
    let fired = s.a.faults.disarm();
    if !fired {
        result.expect("sync without a crash succeeds");
        settle(&[&s.a, &s.b]);
        check_outcome(&s);
        return false;
    }
    assert!(
        result.is_err(),
        "crash #{nth} ({when:?}) was swallowed: {result:?}"
    );

    let Scenario {
        net,
        a,
        b,
        shared,
        task,
        deleted_by_a,
        new_on_a,
        new_on_b,
    } = s;
    let a = net.reopen(a); // simulate an app restart
    let s = Scenario {
        net,
        a,
        b,
        shared,
        task,
        deleted_by_a,
        new_on_a,
        new_on_b,
    };
    settle(&[&s.a, &s.b]);
    check_outcome(&s);
    true
}

#[test]
fn every_crash_point_during_a_merge_recovers_without_loss() {
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8);
    for when in [Crash::Before, Crash::After] {
        let mut start = 0;
        let mut total = 0;
        'outer: loop {
            let fired: Vec<bool> = std::thread::scope(|scope| {
                let handles: Vec<_> = (start..start + workers)
                    .map(|nth| scope.spawn(move || run_case(nth, when)))
                    .collect();
                handles
                    .into_iter()
                    .map(|h| h.join().expect("case panicked"))
                    .collect()
            });
            for f in fired {
                if !f {
                    break 'outer;
                }
                total += 1;
            }
            start += workers;
        }
        assert!(total > 20, "expected many crash points, got {total}");
        eprintln!("{when:?}: recovered from {total} crash points");
    }
}
