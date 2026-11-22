//! Randomized simulation: several devices make random edits, go offline,
//! come back and sync in random order. Afterwards every device must hold the
//! same valid workspace and no edit may have been silently lost.
//!
//! The "no silent loss" check needs to know which edits a deletion was
//! allowed to remove. Every action is committed immediately, so an edit was
//! known to the deleting device exactly when the edit's commit is an ancestor
//! of the commit the device was on when it deleted. Edits the deleter never
//! saw must survive (the entity is restored). An edit that was undone
//! before syncing (a line added, then removed) leaves nothing to lose.
//!
//! The same runs through a cloud folder remote, where the simulated cloud
//! also copies one random file at a time between steps, so refs often
//! arrive before their objects and devices see each other late.
//!
//! Environment variables:
//! - `DOCSYNC_SIM_SEEDS`: number of seeds to run (default 24)
//! - `DOCSYNC_SIM_STEPS`: actions per seed (default 80)
//! - `DOCSYNC_SIM_SEED`: run only this seed (to reproduce a failure)
//! - `DOCSYNC_SIM_TRACE`: print every action and sync
//! - `DOCSYNC_SIM_KEEP`: keep the device repositories on disk for inspection

mod common;

use std::collections::{HashMap, HashSet};

use common::{Device, Net, real_git};
use docsync::GitBackend;
use docsync::git::Oid;
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde_json::{Map, Value, json};

const DEVICES: usize = 3;
const PROPERTY_KEYS: &[&str] = &["status", "owner", "priority"];
const CELL_KEYS: &[&str] = &["name", "status"];

#[derive(Default)]
struct Oracle {
    counter: usize,
    /// (entity, commit) for every JSON value written into an entity (page
    /// properties, database creation, row creation and cells; row writes
    /// count for the row, not its database). Body lines are tracked
    /// separately in `lines`. Only additions that are still present count:
    /// adding a line and removing it again leaves nothing to lose, so a
    /// concurrent deletion may win.
    writes: Vec<(String, Oid, Option<Field>)>,
    /// (entity, commit the deleting device was on).
    deletions: Vec<(String, Oid)>,
    /// (page, token, commit) for every line added to a page body.
    lines: Vec<(String, String, Oid)>,
    /// Lines a device deliberately removed.
    removed_lines: HashSet<String>,
    /// Every value ever written per (file entity, key).
    values: HashMap<(String, String), HashSet<String>>,
}

/// The JSON value a write put into a file, so the check can tell whether a
/// later write (or a newest-wins merge) overwrote it.
#[derive(Debug, Clone)]
struct Field {
    file: String,
    path: Vec<String>,
    value: Value,
}

impl Field {
    fn new(file: String, path: &[&str], value: &Value) -> Option<Self> {
        Some(Field {
            file,
            path: path.iter().map(|s| s.to_string()).collect(),
            value: value.clone(),
        })
    }
}

fn page_key(id: &str) -> String {
    format!("pages/{id}")
}
fn db_key(id: &str) -> String {
    format!("databases/{id}")
}
fn row_key(db: &str, row: &str) -> String {
    format!("databases/{db}/rows/{row}")
}

fn pick<'a, T>(rng: &mut ChaCha8Rng, items: &'a [T]) -> Option<&'a T> {
    if items.is_empty() {
        None
    } else {
        Some(&items[rng.random_range(0..items.len())])
    }
}

fn token_lines(body: &str) -> Vec<usize> {
    body.lines()
        .enumerate()
        .filter(|(_, l)| l.starts_with("tok-"))
        .map(|(i, _)| i)
        .collect()
}

fn set_line(body: &str, index: usize, replacement: Option<&str>) -> String {
    let mut lines: Vec<&str> = body.lines().collect();
    match replacement {
        Some(r) => lines[index] = r,
        None => {
            lines.remove(index);
        }
    }
    lines.iter().map(|l| format!("{l}\n")).collect()
}

impl Oracle {
    fn token(&mut self) -> String {
        self.counter += 1;
        format!("tok-{}", self.counter)
    }

    fn step(&mut self, net: &Net, d: &Device, rng: &mut ChaCha8Rng) {
        let ws = &d.ws;
        let pages = ws.list_pages().unwrap();
        let dbs = ws.list_databases().unwrap();
        let before = d.head();
        let mut wrote: Vec<(String, Option<Field>)> = Vec::new();
        let mut new_lines: Vec<(String, String)> = Vec::new();

        let mut roll = rng.random_range(0..100);
        if pages.is_empty() && (10..60).contains(&roll) {
            roll = 0;
        }
        if dbs.is_empty() && (63..80).contains(&roll) {
            roll = 60;
        }

        match roll {
            0..10 => {
                let id = format!("p{}", self.counter);
                let tok = self.token();
                ws.create_page_with_id(&id, "page", None).unwrap();
                ws.write_body(&id, &format!("{tok}\n")).unwrap();
                new_lines.push((id, tok));
            }
            10..30 => {
                let page = pick(rng, &pages).unwrap().clone();
                let body = ws.read_body(&page).unwrap();
                let mut lines: Vec<String> = body.lines().map(String::from).collect();
                let tok = self.token();
                lines.insert(rng.random_range(0..=lines.len()), tok.clone());
                ws.write_body(&page, &lines.iter().map(|l| format!("{l}\n")).collect::<String>())
                    .unwrap();
                new_lines.push((page, tok));
            }
            30..46 => {
                let page = pick(rng, &pages).unwrap().clone();
                let body = ws.read_body(&page).unwrap();
                let Some(&index) = pick(rng, &token_lines(&body)) else {
                    return;
                };
                let old = body.lines().nth(index).unwrap().to_string();
                let replacement = if roll < 38 { None } else { Some(self.token()) };
                ws.write_body(&page, &set_line(&body, index, replacement.as_deref()))
                    .unwrap();
                self.removed_lines.insert(old);
                if let Some(tok) = replacement {
                    new_lines.push((page, tok));
                }
            }
            46..56 => {
                let page = pick(rng, &pages).unwrap().clone();
                let key = *pick(rng, PROPERTY_KEYS).unwrap();
                let value = json!(self.token());
                ws.set_page_property(&page, key, value.clone()).unwrap();
                self.values
                    .entry((page_key(&page), key.into()))
                    .or_default()
                    .insert(value.to_string());
                let file = format!("{}/meta.json", page_key(&page));
                wrote.push((page_key(&page), Field::new(file, &["properties", key], &value)));
            }
            56..60 => {
                let page = pick(rng, &pages).unwrap().clone();
                ws.delete_page(&page).unwrap();
                trace(&format!("{} delete {page} at {}", d.name, before.short()));
                self.deletions.push((page_key(&page), before));
            }
            60..63 => {
                let id = format!("d{}", self.counter);
                self.counter += 1;
                ws.create_database_with_id(&id, "db", CELL_KEYS).unwrap();
                wrote.push((db_key(&id), None));
            }
            63..70 => {
                let db = pick(rng, &dbs).unwrap().clone();
                let row = format!("r{}", self.counter);
                let value = json!(self.token());
                let mut cells = Map::new();
                cells.insert("name".into(), value.clone());
                ws.add_row_with_id(&db, &row, cells).unwrap();
                self.values
                    .entry((row_key(&db, &row), "name".into()))
                    .or_default()
                    .insert(value.to_string());
                let file = format!("{}.json", row_key(&db, &row));
                wrote.push((row_key(&db, &row), Field::new(file, &["cells", "name"], &value)));
            }
            70..79 => {
                let db = pick(rng, &dbs).unwrap().clone();
                let rows = ws.list_rows(&db).unwrap();
                let Some(row) = pick(rng, &rows).cloned() else {
                    return;
                };
                if roll < 76 {
                    let key = *pick(rng, CELL_KEYS).unwrap();
                    let value = json!(self.token());
                    ws.set_cell(&db, &row, key, value.clone()).unwrap();
                    self.values
                        .entry((row_key(&db, &row), key.into()))
                        .or_default()
                        .insert(value.to_string());
                    let file = format!("{}.json", row_key(&db, &row));
                    wrote.push((row_key(&db, &row), Field::new(file, &["cells", key], &value)));
                } else {
                    ws.delete_row(&db, &row).unwrap();
                    self.deletions.push((row_key(&db, &row), before));
                }
            }
            79..80 => {
                let db = pick(rng, &dbs).unwrap().clone();
                ws.delete_database(&db).unwrap();
                self.deletions.push((db_key(&db), before));
            }
            80..95 => {
                let report = d.sync();
                trace(&format!(
                    "{} sync {} -> {} {:?}",
                    d.name,
                    before.short(),
                    d.head().short(),
                    report
                ));
                return;
            }
            95..98 => {
                let offline = rng.random_bool(0.5);
                d.faults.set_offline(offline);
                return;
            }
            _ => {
                net.clock.advance(rng.random_range(0..=3));
                return;
            }
        }

        d.commit();
        let after = d.head();
        trace(&format!(
            "{} roll {roll} wrote {wrote:?} lines {new_lines:?} -> {}",
            d.name,
            after.short()
        ));
        for (entity, field) in wrote {
            self.writes.push((entity, after.clone(), field));
        }
        for (page, tok) in new_lines {
            self.lines.push((page, tok, after.clone()));
        }
    }

    fn check(&self, d: &Device) {
        let git = real_git();
        let root = d.root();
        let deletions = |entities: &[String]| -> Vec<&Oid> {
            self.deletions
                .iter()
                .filter(|(e, _)| entities.contains(e))
                .map(|(_, h)| h)
                .collect()
        };
        let survives = |commit: &Oid, entities: &[String]| {
            !deletions(entities)
                .iter()
                .any(|h| git.is_ancestor(root, commit, h).unwrap())
        };
        // A value that some later commit overwrote (on any device, or by a
        // newest-wins merge) is no longer content a deletion could lose.
        let overwritten = |commit: &Oid, field: &Field| {
            let out = common::git_command()
                .arg("-C")
                .arg(root)
                .args(["rev-list", "--ancestry-path", &format!("{commit}..HEAD")])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).lines().any(|c| {
                let Some(blob) = git.resolve(root, &format!("{c}:{}", field.file)).unwrap() else {
                    return false;
                };
                let value: Value = serde_json::from_slice(&git.read_blob(root, &blob).unwrap()).unwrap();
                docsync::json_merge::value_at(&value, &field.path) != Some(&field.value)
            })
        };
        let must_exist = |entity: &str, deleted_by: &[String]| {
            self.writes.iter().any(|(e, c, field)| {
                e == entity && survives(c, deleted_by) && !field.as_ref().is_some_and(|f| overwritten(c, f))
            })
        };

        let written: HashSet<&String> = self.writes.iter().map(|(e, _, _)| e).collect();
        for entity in written {
            let parts: Vec<&str> = entity.split('/').collect();
            match parts.as_slice() {
                ["pages", id] => {
                    if must_exist(entity, std::slice::from_ref(entity)) {
                        assert!(d.ws.page_exists(id), "page {id} was lost");
                    }
                }
                // A database must survive if its creation was never seen by a
                // deleter, or if one of its rows must survive (checked below:
                // a surviving row implies its schema via `assert_valid`).
                ["databases", id] => {
                    if must_exist(entity, std::slice::from_ref(entity)) {
                        assert!(d.ws.database_exists(id), "database {id} was lost");
                    }
                }
                ["databases", db, "rows", row] => {
                    if must_exist(entity, &[entity.clone(), db_key(db)]) {
                        assert!(d.ws.row_exists(db, row), "row {db}/{row} was lost");
                        assert!(d.ws.database_exists(db), "database {db} was lost with row {row}");
                    }
                }
                _ => unreachable!(),
            }
        }

        for (page, tok, commit) in &self.lines {
            if self.removed_lines.contains(tok) || !survives(commit, &[page_key(page)]) {
                continue;
            }
            let body =
                d.ws.read_body(page)
                    .unwrap_or_else(|_| panic!("page {page} with {tok} was lost"));
            assert!(
                body.lines().any(|l| l == tok),
                "{tok} was lost from page {page}:\n{body}"
            );
        }

        let check_values = |entity: String, values: &Value| {
            for (key, value) in values.as_object().into_iter().flatten() {
                let allowed = self.values.get(&(entity.clone(), key.clone()));
                assert!(
                    allowed.is_some_and(|a| a.contains(&value.to_string())),
                    "{entity}: {key} = {value} was never written"
                );
            }
        };
        for page in d.ws.list_pages().unwrap() {
            check_values(
                page_key(&page),
                &d.ws.read_page_meta(&page).unwrap()["properties"],
            );
        }
        for db in d.ws.list_databases().unwrap() {
            for row in d.ws.list_rows(&db).unwrap() {
                check_values(row_key(&db, &row), &d.ws.read_row(&db, &row).unwrap()["cells"]);
            }
        }
    }
}

fn trace(line: &str) {
    if std::env::var_os("DOCSYNC_SIM_TRACE").is_some() {
        eprintln!("{line}");
    }
}

fn run_seed(seed: u64, steps: usize, folder: bool) {
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    let net = if folder { Net::folder() } else { Net::new() };
    let devices: Vec<Device> = (0..DEVICES).map(|i| net.device(&format!("dev{i}"))).collect();
    let mut oracle = Oracle::default();
    for _ in 0..steps {
        let device = &devices[rng.random_range(0..DEVICES)];
        oracle.step(&net, device, &mut rng);
        if folder {
            for _ in 0..rng.random_range(0..6) {
                net.cloud_step(&mut |n| rng.random_range(0..n));
            }
        }
    }
    for d in &devices {
        d.faults.set_offline(false);
    }
    let keep = std::env::var_os("DOCSYNC_SIM_KEEP").is_some();
    if keep {
        eprintln!("keeping {}", net.path().display());
    }
    let net = std::mem::ManuallyDrop::new(net);
    let refs: Vec<&Device> = devices.iter().collect();
    net.settle(&refs);
    oracle.check(&devices[0]);
    drop(devices);
    if !keep {
        drop(std::mem::ManuallyDrop::into_inner(net));
    }
}

fn env_number(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[test]
fn random_concurrent_editing_converges_without_loss() {
    run_seeds(false);
}

#[test]
fn random_editing_through_a_cloud_folder_converges_without_loss() {
    run_seeds(true);
}

fn run_seeds(folder: bool) {
    let steps = env_number("DOCSYNC_SIM_STEPS", 80) as usize;
    let seeds: Vec<u64> = match std::env::var("DOCSYNC_SIM_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
    {
        Some(seed) => vec![seed],
        None => (0..env_number("DOCSYNC_SIM_SEEDS", 24)).collect(),
    };
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8);
    let mut failed: Vec<u64> = Vec::new();
    for chunk in seeds.chunks(workers) {
        std::thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|&seed| {
                    std::thread::Builder::new()
                        .name(format!("seed-{seed}"))
                        .spawn_scoped(scope, move || run_seed(seed, steps, folder))
                        .unwrap()
                })
                .collect();
            failed.extend(
                handles
                    .into_iter()
                    .zip(chunk)
                    .filter_map(|(h, &seed)| h.join().is_err().then_some(seed)),
            );
        });
    }
    assert!(
        failed.is_empty(),
        "failing seeds: {failed:?} (rerun one with DOCSYNC_SIM_SEED=<n>)"
    );
}
