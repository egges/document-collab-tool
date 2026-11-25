//! Reading and writing pages and databases in the on-disk format described
//! in [`crate::layout`]. This is deliberately thin: it only writes files.
//! Syncing is the [`crate::SyncEngine`]'s job.

use std::fs;
use std::path::{Path, PathBuf};

use rand::Rng;
use serde_json::{Map, Value, json};

use crate::database::{Column, ColumnChange, ColumnType, Row, Schema, sort_rows};
use crate::error::IoContext;
use crate::layout::{self, DATABASE_ROWS, DATABASE_SCHEMA, DATABASES_DIR, PAGE_BODY, PAGE_META, PAGES_DIR};
use crate::{Error, Result, front_matter, json_merge};

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

    // ---- workspace settings -------------------------------------------

    /// The workspace's name, from `workspace.json`. It syncs like any other
    /// field, so every device shows the same name; folders and remotes keep
    /// whatever name they were created with. `None` for workspaces made
    /// before names were stored, or when the file is missing or broken.
    pub fn name(&self) -> Option<String> {
        let value = self.read_json(&self.root.join(layout::WORKSPACE_FILE)).ok()?;
        let name = value.get("name")?.as_str()?.trim();
        (!name.is_empty()).then(|| name.to_string())
    }

    /// Rename the workspace. Leading and trailing whitespace is dropped; an
    /// empty name is refused.
    pub fn set_name(&self, name: &str) -> Result<()> {
        let path = self.root.join(layout::WORKSPACE_FILE);
        let name = name.trim();
        if name.is_empty() {
            return Err(Error::InvalidData {
                path: path.display().to_string(),
                message: "a workspace name can't be empty".into(),
            });
        }
        if !path.exists() {
            return self.write_json(&path, &json!({ "name": name }));
        }
        self.update_json(&path, |settings| {
            settings.insert("name".into(), name.into());
        })
    }

    /// Where the workspace is kept besides each device, from
    /// `workspace.json`: written by the device that last moved it, so the
    /// others follow (see "Following a move" in docs/sync-design.md). The
    /// app chooses the format; a single string, so a merge never mixes two
    /// places.
    pub fn kept_in(&self) -> Option<String> {
        let value = self.read_json(&self.root.join(layout::WORKSPACE_FILE)).ok()?;
        let place = value.get("kept_in")?.as_str()?.trim();
        (!place.is_empty()).then(|| place.to_string())
    }

    /// Record where the workspace is kept now. Doesn't commit.
    pub fn set_kept_in(&self, place: &str) -> Result<()> {
        let path = self.root.join(layout::WORKSPACE_FILE);
        if !path.exists() {
            return self.write_json(&path, &json!({ "kept_in": place }));
        }
        self.update_json(&path, |settings| {
            settings.insert("kept_in".into(), place.into());
        })
    }

    // ---- pages ---------------------------------------------------------

    pub fn create_page(&self, title: &str, parent: Option<&str>) -> Result<String> {
        let id = new_id();
        self.create_page_with_id(&id, title, parent)?;
        Ok(id)
    }

    pub fn create_page_with_id(&self, id: &str, title: &str, parent: Option<&str>) -> Result<()> {
        self.create_page_with(id, title, parent, Map::new(), "")
    }

    /// Create a page with its properties and body in one go.
    pub fn create_page_with(
        &self,
        id: &str,
        title: &str,
        parent: Option<&str>,
        properties: Map<String, Value>,
        body: &str,
    ) -> Result<()> {
        let meta = json!({ "id": id, "title": title, "parent": parent, "properties": properties });
        self.write_json(&self.page_dir(id).join(PAGE_META), &meta)?;
        self.write_file(&self.page_dir(id).join(PAGE_BODY), body.as_bytes())
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

    /// How the page is shown (`"width"`, `"textSize"`, ...), in the
    /// `display` field of its meta.json. `None` removes the option, which
    /// means the default. Options merge one by one, like properties.
    pub fn set_page_display(&self, id: &str, key: &str, value: Option<Value>) -> Result<()> {
        self.update_json(&self.page_dir(id).join(PAGE_META), |meta| {
            let display = meta.entry("display").or_insert_with(|| json!({}));
            if !display.is_object() {
                *display = json!({});
            }
            let display = display.as_object_mut().expect("object");
            match value {
                Some(value) => display.insert(key.into(), value),
                None => display.remove(key),
            };
            if display.is_empty() {
                meta.remove("display");
            }
        })
    }

    pub fn read_body(&self, id: &str) -> Result<String> {
        let path = self.page_dir(id).join(PAGE_BODY);
        fs::read_to_string(&path).at(&path)
    }

    pub fn write_body(&self, id: &str, body: &str) -> Result<()> {
        self.write_file(&self.page_dir(id).join(PAGE_BODY), body.as_bytes())
    }

    /// Move YAML front matter at the top of the page's body into its
    /// meta.json: `title` becomes the title, every other field a property.
    /// Front matter was written after meta.json (by another tool or an AI
    /// agent), so its values replace the ones there. Returns whether the
    /// page changed. Doesn't commit.
    ///
    /// meta.json is written first: if the process stops in between, the
    /// front matter is still in the body and is moved again next time.
    pub fn lift_front_matter(&self, id: &str) -> Result<bool> {
        let body = match self.read_body(id) {
            Ok(body) => body,
            Err(Error::Io { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
                return Ok(false);
            }
            Err(e) => return Err(e),
        };
        let Some(front) = front_matter::parse(&body) else {
            return Ok(false);
        };
        self.update_json(&self.page_dir(id).join(PAGE_META), |meta| {
            if let Some(title) = front.title {
                meta.insert("title".into(), title.into());
            }
            let props = meta.entry("properties").or_insert_with(|| json!({}));
            if !props.is_object() {
                *props = json!({});
            }
            props.as_object_mut().expect("object").extend(front.properties);
        })?;
        self.write_body(id, &front.body)?;
        Ok(true)
    }

    /// Where a page's attachments go: `pages/<id>/assets`.
    pub fn page_assets_dir(&self, id: &str) -> PathBuf {
        self.page_dir(id).join(layout::PAGE_ASSETS)
    }

    pub fn delete_page(&self, id: &str) -> Result<()> {
        let dir = self.page_dir(id);
        fs::remove_dir_all(&dir).at(&dir)
    }

    // ---- databases -----------------------------------------------------
    // The format is in [`crate::database`].

    /// A database with text columns whose ids are `columns`.
    pub fn create_database(&self, name: &str, columns: &[&str]) -> Result<String> {
        let id = new_id();
        self.create_database_with_id(&id, name, columns)?;
        Ok(id)
    }

    pub fn create_database_with_id(&self, id: &str, name: &str, columns: &[&str]) -> Result<()> {
        let columns: Map<String, Value> = columns
            .iter()
            .enumerate()
            .map(|(i, col)| {
                let column = Column {
                    id: col.to_string(),
                    name: col.to_string(),
                    kind: ColumnType::Text,
                    position: Some(i as f64),
                    options: Vec::new(),
                };
                (column.id.clone(), column.to_json())
            })
            .collect();
        let schema = json!({ "id": id, "name": name, "columns": columns });
        self.write_json(&self.database_dir(id).join(DATABASE_SCHEMA), &schema)
    }

    pub fn database_exists(&self, id: &str) -> bool {
        self.database_dir(id).join(DATABASE_SCHEMA).is_file()
    }

    pub fn list_databases(&self) -> Result<Vec<String>> {
        list_ids(&self.root.join(DATABASES_DIR), Some(DATABASE_SCHEMA))
    }

    /// The database's schema.json as written.
    pub fn read_database_json(&self, id: &str) -> Result<Value> {
        self.read_json(&self.database_dir(id).join(DATABASE_SCHEMA))
    }

    pub fn read_schema(&self, id: &str) -> Result<Schema> {
        Ok(Schema::from_json(id, &self.read_database_json(id)?))
    }

    /// Every row, in display order. A row file that doesn't parse (a hand
    /// edit) is left out rather than hiding the whole database.
    pub fn read_rows(&self, db: &str) -> Result<Vec<Row>> {
        let mut rows = Vec::new();
        for id in self.list_rows(db)? {
            match self.read_row(db, &id) {
                Ok(value) => rows.push(Row::from_json(&id, &value)),
                Err(Error::InvalidData { .. }) => {}
                Err(e) => return Err(e),
            }
        }
        sort_rows(&mut rows);
        Ok(rows)
    }

    pub fn rename_database(&self, id: &str, name: &str) -> Result<()> {
        self.update_json(&self.database_dir(id).join(DATABASE_SCHEMA), |schema| {
            schema.insert("name".into(), name.into());
        })
    }

    /// Add a column after the others; returns its id.
    pub fn add_column(&self, db: &str, name: &str, kind: ColumnType) -> Result<String> {
        let id = new_id();
        let schema = self.read_schema(db)?;
        let column = Column {
            id: id.clone(),
            name: name.to_string(),
            kind,
            position: Some(schema.next_position()),
            options: Vec::new(),
        };
        self.edit_columns(db, |columns| {
            columns.insert(id.clone(), column.to_json());
        })?;
        Ok(id)
    }

    /// Change a column's name, type, position or options. Cells keep their
    /// values when the type changes; readers treat a value of the wrong type
    /// as text until it is edited.
    pub fn update_column(&self, db: &str, column: &str, change: &ColumnChange) -> Result<()> {
        let path = self.database_dir(db).join(DATABASE_SCHEMA);
        let mut current =
            self.read_schema(db)?
                .column(column)
                .cloned()
                .ok_or_else(|| Error::InvalidData {
                    path: path.display().to_string(),
                    message: format!("no column {column}"),
                })?;
        if let Some(name) = &change.name {
            current.name = name.clone();
        }
        if let Some(kind) = change.kind {
            current.kind = kind;
        }
        if let Some(position) = change.position {
            current.position = Some(position);
        }
        if let Some(options) = &change.options {
            current.options = options.clone();
        }
        self.edit_columns(db, |columns| {
            columns.insert(column.to_string(), current.to_json());
        })
    }

    /// Remove a column from the schema. Its cells stay in the rows, so the
    /// rows aren't all rewritten (and can't conflict with edits elsewhere);
    /// readers ignore cells of unknown columns.
    pub fn remove_column(&self, db: &str, column: &str) -> Result<()> {
        self.edit_columns(db, |columns| {
            columns.remove(column);
        })
    }

    /// Edit the `columns` object, moving a schema in the first format (a
    /// list of names) to the current one first.
    fn edit_columns(&self, db: &str, edit: impl FnOnce(&mut Map<String, Value>)) -> Result<()> {
        let schema = self.read_schema(db)?;
        self.update_json(&self.database_dir(db).join(DATABASE_SCHEMA), |value| {
            let columns = value.entry("columns").or_insert_with(|| json!({}));
            if !columns.is_object() {
                *columns = schema.columns_json();
            }
            edit(columns.as_object_mut().expect("object"));
        })
    }

    /// Add a row after the others. Its position is the time it was made, so
    /// rows added on different devices meanwhile end up in the order they
    /// were added.
    pub fn add_row(&self, db: &str, cells: Map<String, Value>) -> Result<String> {
        let id = new_id();
        self.add_row_with_id(db, &id, cells)?;
        Ok(id)
    }

    pub fn add_row_with_id(&self, db: &str, row: &str, cells: Map<String, Value>) -> Result<()> {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as f64)
            .unwrap_or_default();
        self.write_json(
            &self.row_path(db, row),
            &json!({ "id": row, "position": millis, "cells": cells }),
        )
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

    /// Empty a cell: its key is removed.
    pub fn clear_cell(&self, db: &str, row: &str, column: &str) -> Result<()> {
        self.update_json(&self.row_path(db, row), |r| {
            if let Some(cells) = r.get_mut("cells").and_then(Value::as_object_mut) {
                cells.remove(column);
            }
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
