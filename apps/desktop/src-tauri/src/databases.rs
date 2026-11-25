//! Databases for the window: list, read and edit them (the developer
//! panel's Databases section for now). The format is in
//! `docsync::database`; values are checked against their column's type here,
//! so the window can't write a cell the table view would misread.

use docsync::Workspace;
use docsync::database::{ColumnChange, ColumnType, Schema};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::State;

use crate::commands::{AppState, CmdResult, blocking, text};
use crate::devlog;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSummary {
    id: String,
    name: String,
    columns: usize,
    rows: usize,
}

#[derive(Debug, Serialize)]
pub struct ColumnInfo {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: &'static str,
    /// Sort key for the column order, for moving a column between two others.
    position: Option<f64>,
    options: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RowInfo {
    id: String,
    /// Keyed by column id. May hold cells of removed columns, and values of
    /// another type than their column's (after a type change).
    cells: Map<String, Value>,
}

#[derive(Debug, Serialize)]
pub struct Database {
    id: String,
    name: String,
    columns: Vec<ColumnInfo>,
    rows: Vec<RowInfo>,
    /// Where it is on disk, for the developer panel.
    path: String,
}

fn column_info(schema: &Schema) -> Vec<ColumnInfo> {
    schema
        .columns
        .iter()
        .map(|c| ColumnInfo {
            id: c.id.clone(),
            name: c.name.clone(),
            kind: c.kind.as_str(),
            position: c.position,
            options: c.options.clone(),
        })
        .collect()
}

fn list(ws: &Workspace) -> CmdResult<Vec<DatabaseSummary>> {
    let mut all = Vec::new();
    for id in ws.list_databases().map_err(text)? {
        // A schema that doesn't parse still lists, so it can be opened and deleted.
        let schema = ws
            .read_schema(&id)
            .unwrap_or_else(|_| Schema::from_json(&id, &Value::Null));
        all.push(DatabaseSummary {
            columns: schema.columns.len(),
            rows: ws.list_rows(&id).map_err(text)?.len(),
            name: schema.name,
            id,
        });
    }
    all.sort_by(|a, b| (a.name.to_lowercase(), &a.id).cmp(&(b.name.to_lowercase(), &b.id)));
    Ok(all)
}

fn read(ws: &Workspace, id: &str) -> CmdResult<Database> {
    if !ws.database_exists(id) {
        return Err("This database no longer exists.".into());
    }
    let schema = ws.read_schema(id).map_err(text)?;
    let rows = ws.read_rows(id).map_err(text)?;
    Ok(Database {
        id: id.to_string(),
        name: schema.name.clone(),
        columns: column_info(&schema),
        rows: rows
            .into_iter()
            .map(|r| RowInfo {
                id: r.id,
                cells: r.cells,
            })
            .collect(),
        path: ws
            .root()
            .join(docsync::layout::DATABASES_DIR)
            .join(id)
            .display()
            .to_string(),
    })
}

fn name_of(name: &str, what: &str) -> CmdResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(format!("A {what} needs a name."));
    }
    Ok(name.to_string())
}

fn column_type(name: &str) -> CmdResult<ColumnType> {
    ColumnType::parse(name).ok_or_else(|| format!("“{name}” isn't a column type."))
}

/// Trimmed, without empty or repeated choices, in the order given.
fn clean_options(options: Vec<String>) -> Vec<String> {
    let mut clean: Vec<String> = Vec::new();
    for option in options {
        let option = option.trim();
        if !option.is_empty() && !clean.iter().any(|o| o == option) {
            clean.push(option.to_string());
        }
    }
    clean
}

/// A new database, with one text column called "Name".
fn create(ws: &Workspace, name: &str) -> CmdResult<String> {
    let name = name_of(name, "database")?;
    let id = docsync::workspace::new_id();
    ws.create_database_with_id(&id, &name, &[]).map_err(text)?;
    ws.add_column(&id, "Name", ColumnType::Text).map_err(text)?;
    Ok(id)
}

/// Set a cell, or empty it with `None` (or an empty string). A select
/// value that isn't a choice yet becomes one.
fn write_cell(ws: &Workspace, db: &str, row: &str, column: &str, value: Option<Value>) -> CmdResult<()> {
    if !ws.row_exists(db, row) {
        return Err("This row no longer exists.".into());
    }
    let schema = ws.read_schema(db).map_err(text)?;
    let col = schema.column(column).ok_or("This column no longer exists.")?;
    let value = value.filter(|v| !v.is_null() && v.as_str() != Some(""));
    let Some(value) = value else {
        return ws.clear_cell(db, row, column).map_err(text);
    };
    if !col.kind.accepts(&value) {
        return Err(format!("“{value}” isn't a valid {} value.", col.kind.as_str()));
    }
    if col.kind == ColumnType::Select {
        let choice = value.as_str().unwrap_or_default();
        if !col.options.iter().any(|o| o == choice) {
            let mut options = col.options.clone();
            options.push(choice.to_string());
            let change = ColumnChange {
                options: Some(options),
                ..Default::default()
            };
            ws.update_column(db, column, &change).map_err(text)?;
        }
    }
    ws.set_cell(db, row, column, value).map_err(text)
}

#[tauri::command]
pub async fn list_databases(state: State<'_, AppState>) -> CmdResult<Vec<DatabaseSummary>> {
    let (engine, _) = state.engine()?;
    blocking("list_databases", move || list(&Workspace::new(engine.root()))).await
}

#[tauri::command]
pub async fn read_database(state: State<'_, AppState>, id: String) -> CmdResult<Database> {
    let (engine, _) = state.engine()?;
    blocking("read_database", move || read(&Workspace::new(engine.root()), &id)).await
}

#[tauri::command]
pub async fn create_database(state: State<'_, AppState>, name: String) -> CmdResult<String> {
    let (engine, edited) = state.engine()?;
    blocking("create_database", move || {
        let id = create(&Workspace::new(engine.root()), &name)?;
        devlog::info("app", format!("Created database {id}"));
        edited();
        Ok(id)
    })
    .await
}

#[tauri::command]
pub async fn rename_database(state: State<'_, AppState>, id: String, name: String) -> CmdResult<()> {
    let name = name_of(&name, "database")?;
    let (engine, edited) = state.engine()?;
    blocking("rename_database", move || {
        Workspace::new(engine.root())
            .rename_database(&id, &name)
            .map_err(text)?;
        devlog::debug("app", format!("Renamed database {id}"));
        edited();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn delete_database(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let (engine, edited) = state.engine()?;
    blocking("delete_database", move || {
        Workspace::new(engine.root()).delete_database(&id).map_err(text)?;
        devlog::info("app", format!("Deleted database {id}"));
        edited();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn add_column(
    state: State<'_, AppState>,
    db: String,
    name: String,
    kind: String,
) -> CmdResult<String> {
    let name = name_of(&name, "column")?;
    let kind = column_type(&kind)?;
    let (engine, edited) = state.engine()?;
    blocking("add_column", move || {
        let id = Workspace::new(engine.root())
            .add_column(&db, &name, kind)
            .map_err(text)?;
        devlog::debug(
            "app",
            format!("Database {db}: added {} column {id}", kind.as_str()),
        );
        edited();
        Ok(id)
    })
    .await
}

/// Change a column; arguments left out (null) stay as they are.
#[tauri::command]
pub async fn update_column(
    state: State<'_, AppState>,
    db: String,
    column: String,
    name: Option<String>,
    kind: Option<String>,
    position: Option<f64>,
    options: Option<Vec<String>>,
) -> CmdResult<()> {
    let change = ColumnChange {
        name: name.map(|n| name_of(&n, "column")).transpose()?,
        kind: kind.map(|k| column_type(&k)).transpose()?,
        position: position.filter(|p| p.is_finite()),
        options: options.map(clean_options),
    };
    let (engine, edited) = state.engine()?;
    blocking("update_column", move || {
        Workspace::new(engine.root())
            .update_column(&db, &column, &change)
            .map_err(text)?;
        devlog::debug("app", format!("Database {db}: changed column {column}"));
        edited();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn delete_column(state: State<'_, AppState>, db: String, column: String) -> CmdResult<()> {
    let (engine, edited) = state.engine()?;
    blocking("delete_column", move || {
        Workspace::new(engine.root())
            .remove_column(&db, &column)
            .map_err(text)?;
        devlog::info("app", format!("Database {db}: removed column {column}"));
        edited();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn add_row(state: State<'_, AppState>, db: String) -> CmdResult<String> {
    let (engine, edited) = state.engine()?;
    blocking("add_row", move || {
        let ws = Workspace::new(engine.root());
        if !ws.database_exists(&db) {
            return Err("This database no longer exists.".into());
        }
        let id = ws.add_row(&db, Map::new()).map_err(text)?;
        devlog::debug("app", format!("Database {db}: added row {id}"));
        edited();
        Ok(id)
    })
    .await
}

#[tauri::command]
pub async fn set_cell(
    state: State<'_, AppState>,
    db: String,
    row: String,
    column: String,
    value: Option<Value>,
) -> CmdResult<()> {
    let (engine, edited) = state.engine()?;
    blocking("set_cell", move || {
        write_cell(&Workspace::new(engine.root()), &db, &row, &column, value)?;
        devlog::debug("app", format!("Database {db}: set row {row}, column {column}"));
        edited();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn delete_row(state: State<'_, AppState>, db: String, row: String) -> CmdResult<()> {
    let (engine, edited) = state.engine()?;
    blocking("delete_row", move || {
        Workspace::new(engine.root())
            .delete_row(&db, &row)
            .map_err(text)?;
        devlog::debug("app", format!("Database {db}: deleted row {row}"));
        edited();
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn workspace() -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path());
        (dir, ws)
    }

    #[test]
    fn a_new_database_has_a_name_column_and_no_rows() {
        let (_dir, ws) = workspace();
        let id = create(&ws, "  Tasks ").unwrap();
        let db = read(&ws, &id).unwrap();
        assert_eq!(db.name, "Tasks");
        assert_eq!(db.columns.len(), 1);
        assert_eq!(
            (db.columns[0].name.as_str(), db.columns[0].kind),
            ("Name", "text")
        );
        assert!(db.rows.is_empty());
        assert!(create(&ws, " ").is_err());
        assert_eq!(list(&ws).unwrap()[0].columns, 1);
    }

    #[test]
    fn cells_are_checked_against_their_column_and_emptied_with_null() {
        let (_dir, ws) = workspace();
        let db = create(&ws, "T").unwrap();
        let count = ws.add_column(&db, "Count", ColumnType::Number).unwrap();
        let row = ws.add_row(&db, Map::new()).unwrap();
        assert!(write_cell(&ws, &db, &row, &count, Some(json!("three"))).is_err());
        write_cell(&ws, &db, &row, &count, Some(json!(3))).unwrap();
        assert_eq!(ws.read_row(&db, &row).unwrap()["cells"][&count], 3);
        write_cell(&ws, &db, &row, &count, None).unwrap();
        assert_eq!(ws.read_row(&db, &row).unwrap()["cells"], json!({}));
        assert!(write_cell(&ws, &db, &row, "nope", Some(json!(1))).is_err());
        assert!(write_cell(&ws, &db, "gone", &count, Some(json!(1))).is_err());
    }

    #[test]
    fn a_new_select_value_becomes_a_choice() {
        let (_dir, ws) = workspace();
        let db = create(&ws, "T").unwrap();
        let status = ws.add_column(&db, "Status", ColumnType::Select).unwrap();
        let row = ws.add_row(&db, Map::new()).unwrap();
        write_cell(&ws, &db, &row, &status, Some(json!("Doing"))).unwrap();
        write_cell(&ws, &db, &row, &status, Some(json!("Doing"))).unwrap();
        assert_eq!(
            ws.read_schema(&db).unwrap().column(&status).unwrap().options,
            ["Doing"]
        );
    }

    #[test]
    fn options_are_trimmed_and_deduplicated() {
        let given = vec![" A".into(), "".into(), "B".into(), "A ".into()];
        assert_eq!(clean_options(given), ["A", "B"]);
    }
}
