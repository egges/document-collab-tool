//! Reading and writing pages and databases in the on-disk format described
//! in [`crate::layout`]. This is deliberately thin: it only writes files.
//! Syncing is the [`crate::SyncEngine`]'s job.

use std::fs;
use std::path::{Path, PathBuf};

use rand::Rng;
use serde_json::{Map, Value, json};

use crate::error::IoContext;
use crate::layout::{self, DATABASE_ROWS, DATABASE_SCHEMA, DATABASES_DIR, PAGE_BODY, PAGE_META, PAGES_DIR};
use crate::{Error, Result, json_merge};

#[derive(Debug, Clone)]
pub struct Workspace {
    root: PathBuf,
}

/// A random id: 12 characters from `[0-9a-z]`.
pub fn new_id() -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut rng = rand::rng();
    (0..12)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect()
}

impl Workspace {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    // ---- pages ---------------------------------------------------------

    pub fn create_page(&self, title: &str, parent: Option<&str>) -> Result<String> {
        let id = new_id();
        self.create_page_with_id(&id, title, parent)?;
        Ok(id)
    }

    pub fn create_page_with_id(&self, id: &str, title: &str, parent: Option<&str>) -> Result<()> {
        let meta = json!({ "id": id, "title": title, "parent": parent, "properties": {} });
        self.write_json(&self.page_dir(id).join(PAGE_META), &meta)?;
        self.write_file(&self.page_dir(id).join(PAGE_BODY), b"")
    }

    pub fn page_exists(&self, id: &str) -> bool {
        self.page_dir(id).join(PAGE_META).is_file()
    }

    pub fn list_pages(&self) -> Result<Vec<String>> {
        list_ids(&self.root.join(PAGES_DIR), Some(PAGE_META))
    }

    pub fn read_page_meta(&self, id: &str) -> Result<Value> {
        self.read_json(&self.page_dir(id).join(PAGE_META))
    }

    pub fn set_title(&self, id: &str, title: &str) -> Result<()> {
        self.update_json(&self.page_dir(id).join(PAGE_META), |meta| {
            meta.insert("title".into(), title.into());
        })
    }

    pub fn set_parent(&self, id: &str, parent: Option<&str>) -> Result<()> {
        self.update_json(&self.page_dir(id).join(PAGE_META), |meta| {
            meta.insert("parent".into(), parent.into());
        })
    }

    pub fn set_page_property(&self, id: &str, key: &str, value: Value) -> Result<()> {
        self.update_json(&self.page_dir(id).join(PAGE_META), |meta| {
            let props = meta.entry("properties").or_insert_with(|| json!({}));
            if !props.is_object() {
                *props = json!({});
            }
            props.as_object_mut().expect("object").insert(key.into(), value);
        })
    }

    pub fn read_body(&self, id: &str) -> Result<String> {
        let path = self.page_dir(id).join(PAGE_BODY);
        fs::read_to_string(&path).at(&path)
    }

    pub fn write_body(&self, id: &str, body: &str) -> Result<()> {
        self.write_file(&self.page_dir(id).join(PAGE_BODY), body.as_bytes())
    }

    pub fn delete_page(&self, id: &str) -> Result<()> {
        let dir = self.page_dir(id);
        fs::remove_dir_all(&dir).at(&dir)
    }

    // ---- databases -----------------------------------------------------

    pub fn create_database(&self, name: &str, columns: &[&str]) -> Result<String> {
        let id = new_id();
        self.create_database_with_id(&id, name, columns)?;
        Ok(id)
    }

    pub fn create_database_with_id(&self, id: &str, name: &str, columns: &[&str]) -> Result<()> {
        let schema = json!({ "id": id, "name": name, "columns": columns });
        self.write_json(&self.database_dir(id).join(DATABASE_SCHEMA), &schema)
    }

    pub fn database_exists(&self, id: &str) -> bool {
        self.database_dir(id).join(DATABASE_SCHEMA).is_file()
    }

    pub fn list_databases(&self) -> Result<Vec<String>> {
        list_ids(&self.root.join(DATABASES_DIR), Some(DATABASE_SCHEMA))
    }

    pub fn add_row(&self, db: &str, cells: Map<String, Value>) -> Result<String> {
        let id = new_id();
        self.add_row_with_id(db, &id, cells)?;
        Ok(id)
    }

    pub fn add_row_with_id(&self, db: &str, row: &str, cells: Map<String, Value>) -> Result<()> {
        self.write_json(&self.row_path(db, row), &json!({ "id": row, "cells": cells }))
    }

    pub fn row_exists(&self, db: &str, row: &str) -> bool {
        self.row_path(db, row).is_file()
    }

    pub fn list_rows(&self, db: &str) -> Result<Vec<String>> {
        list_ids(&self.database_dir(db).join(DATABASE_ROWS), None)
    }

    pub fn read_row(&self, db: &str, row: &str) -> Result<Value> {
        self.read_json(&self.row_path(db, row))
    }

    pub fn set_cell(&self, db: &str, row: &str, column: &str, value: Value) -> Result<()> {
        self.update_json(&self.row_path(db, row), |r| {
            let cells = r.entry("cells").or_insert_with(|| json!({}));
            if !cells.is_object() {
                *cells = json!({});
            }
            cells
                .as_object_mut()
                .expect("object")
                .insert(column.into(), value);
        })
    }

    pub fn delete_row(&self, db: &str, row: &str) -> Result<()> {
        let path = self.row_path(db, row);
        fs::remove_file(&path).at(&path)
    }

    pub fn delete_database(&self, id: &str) -> Result<()> {
        let dir = self.database_dir(id);
        fs::remove_dir_all(&dir).at(&dir)
    }

    // ---- helpers -------------------------------------------------------

    fn page_dir(&self, id: &str) -> PathBuf {
        self.root.join(PAGES_DIR).join(id)
    }

    fn database_dir(&self, id: &str) -> PathBuf {
        self.root.join(DATABASES_DIR).join(id)
    }

    fn row_path(&self, db: &str, row: &str) -> PathBuf {
        self.database_dir(db)
            .join(DATABASE_ROWS)
            .join(format!("{row}.json"))
    }

    fn read_json(&self, path: &Path) -> Result<Value> {
        let bytes = fs::read(path).at(path)?;
        serde_json::from_slice(&bytes).map_err(|e| Error::InvalidData {
            path: path.display().to_string(),
            message: e.to_string(),
        })
    }

    fn write_json(&self, path: &Path, value: &Value) -> Result<()> {
        self.write_file(path, &json_merge::to_canonical_bytes(value))
    }

    fn update_json(&self, path: &Path, edit: impl FnOnce(&mut Map<String, Value>)) -> Result<()> {
        let mut value = self.read_json(path)?;
        let map = value.as_object_mut().ok_or_else(|| Error::InvalidData {
            path: path.display().to_string(),
            message: "expected a JSON object".into(),
        })?;
        edit(map);
        self.write_json(path, &value)
    }

    /// Write via a temporary file and rename, so a crash never leaves a
    /// half-written file for the next commit to pick up.
    fn write_file(&self, path: &Path, content: &[u8]) -> Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).at(dir)?;
        }
        let mut tmp = path.as_os_str().to_owned();
        tmp.push(layout::TEMP_SUFFIX);
        let tmp = PathBuf::from(tmp);
        fs::write(&tmp, content).at(&tmp)?;
        fs::rename(&tmp, path).at(path)
    }
}

/// Ids of the entries in `dir`: subdirectories containing `marker`, or with
/// no marker, `<id>.json` files. Conflict copies are skipped, and so are
/// directories without their marker file: git does not track directories,
/// so an emptied one can linger on disk after its files were synced away.
fn list_ids(dir: &Path, marker: Option<&str>) -> Result<Vec<String>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).at(dir),
    };
    let mut ids = Vec::new();
    for entry in entries {
        let entry = entry.at(dir)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name.contains(layout::CONFLICT_COPY_MARKER) {
            continue;
        }
        let is_dir = entry.file_type().at(entry.path())?.is_dir();
        match (marker, is_dir) {
            (Some(marker), true) => {
                if entry.path().join(marker).is_file() {
                    ids.push(name);
                }
            }
            (None, false) => {
                if let Some(id) = name.strip_suffix(".json") {
                    ids.push(id.to_string());
                }
            }
            _ => {}
        }
    }
    ids.sort();
    Ok(ids)
}
