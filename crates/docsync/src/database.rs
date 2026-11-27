//! Databases: typed columns, and rows that are pages, read from the files
//! described in [`crate::layout`].
//!
//! ```text
//! databases/<db>/schema.json
//!   {"id", "name", "columns": {"<col>": {"name", "type", "position", "options"?}}}
//! pages/<row>/meta.json
//!   {"id", "title", "properties": {"<col>": value}, "row": {"database": "<db>", "position"?}, ...}
//! pages/<row>/page.md
//!   the row's text
//! ```
//!
//! Every row is a page, as in Notion: a page like any other, with its text,
//! attachments and display options, whose `row` field names its database.
//! Its properties are its cells, keyed by column id, and their types are the
//! database's columns. Its title is the cell of the first text column
//! ([`Schema::title_column`]). Rows don't show in the page tree.
//!
//! A row is its own entity for sync, but a database and its rows are
//! restored together: a database deleted on one device while one of its rows
//! is edited or added on another comes back with all its rows
//! ([`crate::merge`]).
//!
//! Columns are an object keyed by column id, not a list, so two devices that
//! add, rename or retype different columns change different fields and merge
//! cleanly ([`crate::json_merge`]). The order is each column's `position`, so
//! moving a column changes one number. Cells are keyed by column id too, so
//! renaming a column never touches the rows.
//!
//! Reading is lenient, since files can be edited by hand or by an agent: an
//! unknown type reads as text, a missing position sorts last, and the first
//! format (`"columns": ["name", ...]`, text columns whose id is their name)
//! still reads. Writing a column change moves such a schema to the current
//! format.

use serde_json::{Map, Value, json};

/// What a column holds, and how its cells are stored in JSON.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnType {
    /// A string.
    Text,
    /// A JSON number.
    Number,
    /// `true` or `false`.
    Checkbox,
    /// One of the column's `options`, as a string.
    Select,
    /// `"YYYY-MM-DD"`.
    Date,
    /// A string, shown as a link.
    Url,
}

impl ColumnType {
    pub const ALL: [ColumnType; 6] = [
        ColumnType::Text,
        ColumnType::Number,
        ColumnType::Checkbox,
        ColumnType::Select,
        ColumnType::Date,
        ColumnType::Url,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ColumnType::Text => "text",
            ColumnType::Number => "number",
            ColumnType::Checkbox => "checkbox",
            ColumnType::Select => "select",
            ColumnType::Date => "date",
            ColumnType::Url => "url",
        }
    }

    pub fn parse(name: &str) -> Option<ColumnType> {
        ColumnType::ALL.into_iter().find(|t| t.as_str() == name)
    }

    /// Whether `value` is a valid cell of this type. An empty cell has no
    /// value at all (the key is left out), never `null` or `""`.
    pub fn accepts(self, value: &Value) -> bool {
        match self {
            ColumnType::Text | ColumnType::Url | ColumnType::Select => {
                value.as_str().is_some_and(|s| !s.is_empty())
            }
            ColumnType::Number => value.as_f64().is_some_and(f64::is_finite),
            ColumnType::Checkbox => value.is_boolean(),
            ColumnType::Date => value.as_str().is_some_and(is_date),
        }
    }
}

/// `YYYY-MM-DD` with a plausible month and day.
fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let digits = |r: std::ops::Range<usize>| {
        b[r.clone()]
            .iter()
            .all(u8::is_ascii_digit)
            .then(|| s[r].parse::<u32>().ok())
            .flatten()
    };
    match (digits(0..4), digits(5..7), digits(8..10)) {
        (Some(_), Some(month), Some(day)) => (1..=12).contains(&month) && (1..=31).contains(&day),
        _ => false,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Column {
    pub id: String,
    pub name: String,
    pub kind: ColumnType,
    /// Sort key for the column order. Columns without one sort last.
    pub position: Option<f64>,
    /// The choices of a select column, in order.
    pub options: Vec<String>,
}

impl Column {
    /// The column as stored in schema.json, without its id (the key).
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("name".into(), self.name.clone().into());
        map.insert("type".into(), self.kind.as_str().into());
        if let Some(position) = self.position {
            map.insert("position".into(), json!(position));
        }
        if !self.options.is_empty() {
            map.insert("options".into(), json!(self.options));
        }
        Value::Object(map)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Schema {
    pub id: String,
    pub name: String,
    /// In display order.
    pub columns: Vec<Column>,
}

impl Schema {
    /// Read a schema.json value. `id` is the database's folder name, which
    /// wins over an `id` field that disagrees.
    pub fn from_json(id: &str, value: &Value) -> Schema {
        Schema {
            id: id.to_string(),
            name: value["name"].as_str().unwrap_or_default().to_string(),
            columns: columns_from_json(&value["columns"]),
        }
    }

    pub fn column(&self, id: &str) -> Option<&Column> {
        self.columns.iter().find(|c| c.id == id)
    }

    /// A position after every column.
    pub fn next_position(&self) -> f64 {
        next_position(&self.columns)
    }

    /// The `columns` field in the current format.
    pub fn columns_json(&self) -> Value {
        Value::Object(self.columns.iter().map(|c| (c.id.clone(), c.to_json())).collect())
    }

    /// The column a row's title is in, which is its title as a page: the
    /// first text column.
    pub fn title_column(&self) -> Option<&Column> {
        self.columns.iter().find(|c| c.kind == ColumnType::Text)
    }
}

/// A position after every column.
pub fn next_position(columns: &[Column]) -> f64 {
    columns
        .iter()
        .filter_map(|c| c.position)
        .fold(-1.0_f64, f64::max)
        .floor()
        + 1.0
}

/// Columns from a `columns` field (a database's schema, or a page's
/// property types), in display order.
pub fn columns_from_json(value: &Value) -> Vec<Column> {
    let mut columns: Vec<Column> = match value {
        Value::Object(map) => map
            .iter()
            .map(|(id, col)| Column {
                id: id.clone(),
                name: col["name"].as_str().unwrap_or(id).to_string(),
                kind: col["type"]
                    .as_str()
                    .and_then(ColumnType::parse)
                    .unwrap_or(ColumnType::Text),
                position: col["position"].as_f64(),
                options: col["options"]
                    .as_array()
                    .map(|o| o.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                    .unwrap_or_default(),
            })
            .collect(),
        // The first format: a list of names, each a text column.
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .enumerate()
            .map(|(i, name)| Column {
                id: name.to_string(),
                name: name.to_string(),
                kind: ColumnType::Text,
                position: Some(i as f64),
                options: Vec::new(),
            })
            .collect(),
        _ => Vec::new(),
    };
    columns.sort_by(|a, b| {
        let pos = |c: &Column| c.position.unwrap_or(f64::INFINITY);
        pos(a).total_cmp(&pos(b)).then_with(|| a.id.cmp(&b.id))
    });
    columns
}

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub id: String,
    /// Sort key for the row order; rows without one sort last, by id.
    pub position: Option<f64>,
    pub cells: Map<String, Value>,
}

impl Row {
    /// A row from its page's meta.json: the position in its `row` field,
    /// the cells in its properties.
    pub fn from_meta(id: &str, meta: &Value) -> Row {
        Row {
            id: id.to_string(),
            position: meta["row"]["position"].as_f64(),
            cells: meta["properties"].as_object().cloned().unwrap_or_default(),
        }
    }
}

/// Sort rows into display order.
pub fn sort_rows(rows: &mut [Row]) {
    rows.sort_by(|a, b| {
        let pos = |r: &Row| r.position.unwrap_or(f64::INFINITY);
        pos(a).total_cmp(&pos(b)).then_with(|| a.id.cmp(&b.id))
    });
}

/// A change to a column; `None` leaves that part as it is.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ColumnChange {
    pub name: Option<String>,
    pub kind: Option<ColumnType>,
    pub position: Option<f64>,
    pub options: Option<Vec<String>>,
}

impl ColumnChange {
    pub fn apply(&self, column: &mut Column) {
        if let Some(name) = &self.name {
            column.name = name.clone();
        }
        if let Some(kind) = self.kind {
            column.kind = kind;
        }
        if let Some(position) = self.position {
            column.position = Some(position);
        }
        if let Some(options) = &self.options {
            column.options = options.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns_read_in_position_order_with_unknown_types_as_text() {
        let schema = Schema::from_json(
            "db1",
            &json!({
                "id": "db1",
                "name": "Tasks",
                "columns": {
                    "b": {"name": "Done", "type": "checkbox", "position": 2},
                    "a": {"name": "Title", "type": "text", "position": 1},
                    "c": {"name": "Odd", "type": "hologram"},
                    "d": {"name": "Status", "type": "select", "position": 1.5, "options": ["Todo", "Done", 3]}
                }
            }),
        );
        assert_eq!(schema.name, "Tasks");
        let ids: Vec<&str> = schema.columns.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["a", "d", "b", "c"]);
        assert_eq!(schema.column("c").unwrap().kind, ColumnType::Text);
        assert_eq!(schema.column("d").unwrap().options, ["Todo", "Done"]);
        assert_eq!(schema.next_position(), 3.0);
    }

    #[test]
    fn the_first_format_reads_as_text_columns_named_by_their_ids() {
        let schema = Schema::from_json("db", &json!({"name": "T", "columns": ["name", "status"]}));
        assert_eq!(schema.columns.len(), 2);
        assert_eq!(schema.columns[1].id, "status");
        assert_eq!(schema.columns[1].name, "status");
        assert_eq!(
            schema.columns_json(),
            json!({
                "name": {"name": "name", "type": "text", "position": 0.0},
                "status": {"name": "status", "type": "text", "position": 1.0}
            })
        );
    }

    #[test]
    fn cell_values_must_match_their_column_type() {
        use ColumnType::*;
        assert!(Text.accepts(&json!("hi")));
        assert!(!Text.accepts(&json!("")));
        assert!(!Text.accepts(&json!(3)));
        assert!(Number.accepts(&json!(3.5)));
        assert!(!Number.accepts(&json!("3")));
        assert!(Checkbox.accepts(&json!(false)));
        assert!(Date.accepts(&json!("2026-11-25")));
        assert!(!Date.accepts(&json!("2026-13-01")));
        assert!(!Date.accepts(&json!("25-11-2026")));
        assert!(!Select.accepts(&Value::Null));
    }

    #[test]
    fn rows_sort_by_position_then_id() {
        let mut rows = vec![
            Row::from_meta("c", &json!({"properties": {}})),
            Row::from_meta("b", &json!({"row": {"position": 2}, "properties": {"x": 1}})),
            Row::from_meta("a", &json!({"row": {"position": 5}})),
        ];
        sort_rows(&mut rows);
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["b", "a", "c"]);
        assert_eq!(rows[0].cells["x"], 1);
    }
}
