//! Database pages: pages that show a database as a table or a board
//! instead of text. They sit in the page tree like any other page, and
//! what they show is in their meta.json:
//!
//! ```text
//! pages/<page>/meta.json
//!   {"id", "title", "parent", ...,
//!    "database": {"id": "<db>", "views": {"<view>": {"name", "type", "position",
//!                                                   "sort"?: {"column", "direction"},
//!                                                   "groupBy"?: "<column>"}}}}
//! ```
//!
//! `database.id` is left out until the page has a database (it was made in a
//! workspace that had some, and the user is still choosing one). Views are
//! keyed by id, like columns, so two devices changing different views, or
//! different settings of one view, merge cleanly. A view's sort and grouping
//! belong to the view, so everyone who opens the page sees the same.
//!
//! Reading is lenient, as with schemas: an unknown view type reads as a
//! table, and a page whose `database` field isn't an object is a regular
//! page.

use serde_json::{Value, json};

/// How a view shows the rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewType {
    /// A row per row, a column per column.
    Table,
    /// Cards in a lane per choice of a select (or checkbox) column.
    Board,
}

impl ViewType {
    pub fn as_str(self) -> &'static str {
        match self {
            ViewType::Table => "table",
            ViewType::Board => "board",
        }
    }

    pub fn parse(name: &str) -> Option<ViewType> {
        [ViewType::Table, ViewType::Board]
            .into_iter()
            .find(|t| t.as_str() == name)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Sort {
    pub column: String,
    /// "asc" or "desc".
    pub descending: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct View {
    pub id: String,
    pub name: String,
    pub kind: ViewType,
    /// Sort key for the order of the view tabs; views without one sort last.
    pub position: Option<f64>,
    pub sort: Option<Sort>,
    /// The column a board groups its cards by.
    pub group_by: Option<String>,
}

impl View {
    pub fn new(id: &str, name: &str, kind: ViewType, position: f64) -> View {
        View {
            id: id.to_string(),
            name: name.to_string(),
            kind,
            position: Some(position),
            sort: None,
            group_by: None,
        }
    }

    pub fn from_json(id: &str, value: &Value) -> View {
        let kind = value["type"]
            .as_str()
            .and_then(ViewType::parse)
            .unwrap_or(ViewType::Table);
        let sort = value["sort"]["column"].as_str().map(|column| Sort {
            column: column.to_string(),
            descending: value["sort"]["direction"].as_str() == Some("desc"),
        });
        View {
            id: id.to_string(),
            name: value["name"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| default_name(kind).to_string()),
            kind,
            position: value["position"].as_f64(),
            sort,
            group_by: value["groupBy"].as_str().map(str::to_string),
        }
    }

    /// The view as stored, without its id (the key).
    pub fn to_json(&self) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("name".into(), self.name.clone().into());
        map.insert("type".into(), self.kind.as_str().into());
        if let Some(position) = self.position {
            map.insert("position".into(), json!(position));
        }
        if let Some(sort) = &self.sort {
            let direction = if sort.descending { "desc" } else { "asc" };
            map.insert(
                "sort".into(),
                json!({ "column": sort.column, "direction": direction }),
            );
        }
        if let Some(group_by) = &self.group_by {
            map.insert("groupBy".into(), group_by.clone().into());
        }
        Value::Object(map)
    }
}

/// What a new view of `kind` is called.
pub fn default_name(kind: ViewType) -> &'static str {
    match kind {
        ViewType::Table => "Table",
        ViewType::Board => "Board",
    }
}

/// What a database page shows.
#[derive(Debug, Clone, PartialEq)]
pub struct DatabasePage {
    /// The database, once one is chosen.
    pub database: Option<String>,
    /// In tab order; never empty (a page without views gets a table).
    pub views: Vec<View>,
}

impl DatabasePage {
    /// The page's meta.json read as a database page, or `None` for a
    /// regular page.
    pub fn from_meta(meta: &Value) -> Option<DatabasePage> {
        let field = meta.get("database")?.as_object()?;
        let mut views: Vec<View> = field
            .get("views")
            .and_then(Value::as_object)
            .map(|views| views.iter().map(|(id, v)| View::from_json(id, v)).collect())
            .unwrap_or_default();
        views.sort_by(|a, b| {
            let pos = |v: &View| v.position.unwrap_or(f64::INFINITY);
            pos(a).total_cmp(&pos(b)).then_with(|| a.id.cmp(&b.id))
        });
        if views.is_empty() {
            // Written by hand or by an agent without views: a table, with a
            // fixed id so every device shows the same one.
            views.push(View::new("table", "Table", ViewType::Table, 0.0));
        }
        Some(DatabasePage {
            database: field
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_string),
            views,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regular_pages_are_not_database_pages() {
        assert_eq!(DatabasePage::from_meta(&json!({"title": "x"})), None);
        assert_eq!(DatabasePage::from_meta(&json!({"database": "abc"})), None);
    }

    #[test]
    fn views_read_in_position_order_and_unknown_types_are_tables() {
        let page = DatabasePage::from_meta(&json!({
            "database": {
                "id": "db1",
                "views": {
                    "b": {"name": "Board", "type": "board", "position": 1, "groupBy": "status"},
                    "a": {"name": "All", "type": "table", "position": 0,
                          "sort": {"column": "due", "direction": "desc"}},
                    "c": {"type": "calendar"}
                }
            }
        }))
        .unwrap();
        assert_eq!(page.database.as_deref(), Some("db1"));
        let ids: Vec<&str> = page.views.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(ids, ["a", "b", "c"]);
        assert_eq!(
            page.views[0].sort,
            Some(Sort {
                column: "due".into(),
                descending: true
            })
        );
        assert_eq!(page.views[1].group_by.as_deref(), Some("status"));
        assert_eq!(
            (page.views[2].kind, page.views[2].name.as_str()),
            (ViewType::Table, "Table")
        );
    }

    #[test]
    fn a_page_without_views_or_database_gets_a_table() {
        let page = DatabasePage::from_meta(&json!({"database": {}})).unwrap();
        assert_eq!(page.database, None);
        assert_eq!(page.views.len(), 1);
        assert_eq!(page.views[0].kind, ViewType::Table);
    }

    #[test]
    fn views_round_trip() {
        let mut view = View::new("v", "Sprint", ViewType::Board, 2.0);
        view.group_by = Some("status".into());
        view.sort = Some(Sort {
            column: "due".into(),
            descending: false,
        });
        assert_eq!(View::from_json("v", &view.to_json()), view);
    }
}
