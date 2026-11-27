//! Pages and their properties, the same way for every page: a regular page
//! keeps typed properties in its meta.json (`docsync::workspace::page_properties_from`),
//! and a database row is a page whose properties are its cells. The commands
//! here take a page id and work out which it is, so the window treats both
//! alike; only deleting a row's property means deleting the column for
//! every row, which the window says before it asks.

use docsync::Workspace;
use docsync::database::{Column, ColumnChange, ColumnType};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::State;

use crate::commands::{AppState, CmdResult, blocking, text};
use crate::databases::{ColumnInfo, clean_options, column_type, columns_info, name_of, write_cell};
use crate::devlog;

/// A page's properties, sent with the page.
#[derive(Debug, Serialize)]
pub struct Properties {
    /// In display order. For a row, its database's columns but the title's.
    columns: Vec<ColumnInfo>,
    /// Keyed by column id; an empty property has no key.
    values: Map<String, Value>,
}

/// Set on a page that's a row of a database.
#[derive(Debug, Serialize)]
pub struct RowOf {
    database: String,
    /// The database's name, to say what deleting a property does.
    name: String,
}

/// What a page is, for reading, renaming and its properties.
pub enum Kind {
    Page,
    Row { database: String },
}

/// A row whose database is gone (a hand edit) reads as a regular page, so
/// it can still be opened, copied from and deleted.
pub fn kind(ws: &Workspace, id: &str) -> CmdResult<Kind> {
    if !ws.page_exists(id) {
        return Err("This page no longer exists.".into());
    }
    match ws.find_row(id) {
        Some(database) if ws.database_exists(&database) => Ok(Kind::Row { database }),
        _ => Ok(Kind::Page),
    }
}

/// A row as a page: its title (the title column's cell), its meta.json (for
/// display options), its properties and its database.
pub fn row_parts(ws: &Workspace, database: &str, row: &str) -> CmdResult<(String, Value, Properties, RowOf)> {
    let schema = ws.read_schema(database).map_err(text)?;
    let json = ws.read_page_meta(row).map_err(text)?;
    let cells = ws.read_row(database, row).map_err(text)?.cells;
    let title_column = schema.title_column().map(|c| c.id.clone());
    let title = title_column
        .as_ref()
        .and_then(|c| cells.get(c))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let columns: Vec<Column> = schema
        .columns
        .iter()
        .filter(|c| Some(&c.id) != title_column.as_ref())
        .cloned()
        .collect();
    let values = cells
        .into_iter()
        .filter(|(k, _)| columns.iter().any(|c| &c.id == k))
        .collect();
    Ok((
        title,
        json,
        Properties {
            columns: columns_info(&columns),
            values,
        },
        RowOf {
            database: database.to_string(),
            name: schema.name,
        },
    ))
}

/// A regular page's properties, from its meta.json.
pub fn page_properties(meta: &Value) -> Properties {
    let (columns, values) = docsync::workspace::page_properties_from(meta);
    Properties {
        columns: columns_info(&columns),
        values,
    }
}

/// Rename a page, or set a row's title cell. A database without a text
/// column gets a "Name" column first, before the others.
pub fn set_title(ws: &Workspace, id: &str, title: &str) -> CmdResult<()> {
    match kind(ws, id)? {
        Kind::Page => ws.set_title(id, title).map_err(text),
        Kind::Row { database } => {
            let schema = ws.read_schema(&database).map_err(text)?;
            let column = match schema.title_column() {
                Some(c) => c.id.clone(),
                None => {
                    let first = schema
                        .columns
                        .iter()
                        .filter_map(|c| c.position)
                        .fold(0.0, f64::min);
                    let id = ws.add_column(&database, "Name", ColumnType::Text).map_err(text)?;
                    let change = ColumnChange {
                        position: Some(first - 1.0),
                        ..Default::default()
                    };
                    ws.update_column(&database, &id, &change).map_err(text)?;
                    id
                }
            };
            write_cell(ws, &database, id, &column, Some(title.into()))
        }
    }
}

/// Set a regular page's property, checked against its type; `None` (or an
/// empty string) empties it. A new select value becomes a choice.
fn write_page_value(ws: &Workspace, id: &str, key: &str, value: Option<Value>) -> CmdResult<()> {
    let (columns, _) = ws.page_properties(id).map_err(text)?;
    let column = columns
        .iter()
        .find(|c| c.id == key)
        .ok_or("This property no longer exists.")?;
    let Some(value) = value.filter(|v| !v.is_null() && v.as_str() != Some("")) else {
        return ws.clear_page_property(id, key).map_err(text);
    };
    if !column.kind.accepts(&value) {
        return Err(format!("“{value}” isn't a valid {} value.", column.kind.as_str()));
    }
    if column.kind == ColumnType::Select {
        let choice = value.as_str().unwrap_or_default();
        if !column.options.iter().any(|o| o == choice) {
            let mut options = column.options.clone();
            options.push(choice.to_string());
            let change = ColumnChange {
                options: Some(options),
                ..Default::default()
            };
            ws.update_page_property(id, key, &change).map_err(text)?;
        }
    }
    ws.set_page_property(id, key, value).map_err(text)
}

fn add(ws: &Workspace, id: &str, name: &str, kind_name: &str) -> CmdResult<String> {
    let name = name_of(name, "property")?;
    let column_kind = column_type(kind_name)?;
    match kind(ws, id)? {
        Kind::Page => ws.add_page_property(id, &name, column_kind).map_err(text),
        Kind::Row { database } => ws.add_column(&database, &name, column_kind).map_err(text),
    }
}

fn update(ws: &Workspace, id: &str, key: &str, change: &ColumnChange) -> CmdResult<()> {
    match kind(ws, id)? {
        Kind::Page => ws.update_page_property(id, key, change).map_err(text),
        Kind::Row { database } => ws.update_column(&database, key, change).map_err(text),
    }
}

fn remove(ws: &Workspace, id: &str, key: &str) -> CmdResult<()> {
    match kind(ws, id)? {
        Kind::Page => ws.remove_page_property(id, key).map_err(text),
        Kind::Row { database } => {
            let schema = ws.read_schema(&database).map_err(text)?;
            if schema.columns.len() <= 1 {
                return Err("A database keeps at least one column.".into());
            }
            ws.remove_column(&database, key).map_err(text)
        }
    }
}

fn set_value(ws: &Workspace, id: &str, key: &str, value: Option<Value>) -> CmdResult<()> {
    match kind(ws, id)? {
        Kind::Page => write_page_value(ws, id, key, value),
        Kind::Row { database } => write_cell(ws, &database, id, key, value),
    }
}

#[tauri::command]
pub async fn add_page_property(
    state: State<'_, AppState>,
    id: String,
    name: String,
    kind: String,
) -> CmdResult<String> {
    let (engine, edited) = state.engine()?;
    blocking("add_page_property", move || {
        let key = add(&Workspace::new(engine.root()), &id, &name, &kind)?;
        devlog::debug("app", format!("Page {id}: added {kind} property {key}"));
        edited();
        Ok(key)
    })
    .await
}

/// Change a property; arguments left out (null) stay as they are.
#[tauri::command]
pub async fn update_page_property(
    state: State<'_, AppState>,
    id: String,
    key: String,
    name: Option<String>,
    kind: Option<String>,
    position: Option<f64>,
    options: Option<Vec<String>>,
) -> CmdResult<()> {
    let change = ColumnChange {
        name: name.map(|n| name_of(&n, "property")).transpose()?,
        kind: kind.map(|k| column_type(&k)).transpose()?,
        position: position.filter(|p| p.is_finite()),
        options: options.map(clean_options),
    };
    let (engine, edited) = state.engine()?;
    blocking("update_page_property", move || {
        update(&Workspace::new(engine.root()), &id, &key, &change)?;
        devlog::debug("app", format!("Page {id}: changed property {key}"));
        edited();
        Ok(())
    })
    .await
}

/// Remove a property. On a row, that's its database's column, for every row.
#[tauri::command]
pub async fn delete_page_property(state: State<'_, AppState>, id: String, key: String) -> CmdResult<()> {
    let (engine, edited) = state.engine()?;
    blocking("delete_page_property", move || {
        remove(&Workspace::new(engine.root()), &id, &key)?;
        devlog::info("app", format!("Page {id}: removed property {key}"));
        edited();
        Ok(())
    })
    .await
}

/// Set a property's value; null empties it.
#[tauri::command]
pub async fn set_page_property_value(
    state: State<'_, AppState>,
    id: String,
    key: String,
    value: Option<Value>,
) -> CmdResult<()> {
    let (engine, edited) = state.engine()?;
    blocking("set_page_property_value", move || {
        set_value(&Workspace::new(engine.root()), &id, &key, value)?;
        devlog::debug("app", format!("Page {id}: set property {key}"));
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
    fn a_pages_properties_are_typed_and_checked() {
        let (_dir, ws) = workspace();
        let page = ws.create_page("Trip", None).unwrap();
        let when = add(&ws, &page, " When ", "date").unwrap();
        assert!(set_value(&ws, &page, &when, Some(json!("soon"))).is_err());
        set_value(&ws, &page, &when, Some(json!("2026-12-01"))).unwrap();
        let stage = add(&ws, &page, "Stage", "select").unwrap();
        set_value(&ws, &page, &stage, Some(json!("Idea"))).unwrap();
        let props = page_properties(&ws.read_page_meta(&page).unwrap());
        assert_eq!(props.columns.len(), 2);
        assert_eq!(props.columns[1].options, ["Idea"]);
        set_value(&ws, &page, &when, None).unwrap();
        remove(&ws, &page, &stage).unwrap();
        let props = page_properties(&ws.read_page_meta(&page).unwrap());
        assert_eq!(props.columns.len(), 1);
        assert!(props.values.is_empty());
        assert!(add(&ws, &page, "x", "hologram").is_err());
    }

    #[test]
    fn a_rows_properties_are_its_database_columns_but_the_title() {
        let (_dir, ws) = workspace();
        let db = crate::databases::create(&ws, "Tasks").unwrap();
        let row = ws.add_row(&db, Map::new()).unwrap();
        set_title(&ws, &row, "Write the plan").unwrap();
        let due = add(&ws, &row, "Due", "date").unwrap();
        set_value(&ws, &row, &due, Some(json!("2026-12-01"))).unwrap();

        let (title, _, props, row_of) = row_parts(&ws, &db, &row).unwrap();
        assert_eq!(title, "Write the plan");
        assert_eq!(row_of.name, "Tasks");
        assert_eq!(props.columns.len(), 1);
        assert_eq!(props.values[&due], "2026-12-01");
        // The column is the database's, for every row.
        assert!(ws.read_schema(&db).unwrap().column(&due).is_some());
        remove(&ws, &row, &due).unwrap();
        assert_eq!(ws.read_schema(&db).unwrap().columns.len(), 1);
        // The last column (the title) can't go.
        let title_column = ws.read_schema(&db).unwrap().columns[0].id.clone();
        assert!(remove(&ws, &row, &title_column).is_err());
    }

    #[test]
    fn a_row_without_a_text_column_gets_one_for_its_title() {
        let (_dir, ws) = workspace();
        let db = ws.create_database("Numbers", &[]).unwrap();
        let n = ws.add_column(&db, "N", ColumnType::Number).unwrap();
        let row = ws.add_row(&db, Map::new()).unwrap();
        set_title(&ws, &row, "First").unwrap();
        let schema = ws.read_schema(&db).unwrap();
        assert_eq!(schema.columns[0].name, "Name");
        assert_eq!(schema.columns[1].id, n);
        assert_eq!(row_parts(&ws, &db, &row).unwrap().0, "First");
    }
}
