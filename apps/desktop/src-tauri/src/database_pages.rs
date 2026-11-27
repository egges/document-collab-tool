//! Database pages for the window: pages that show a database as a table or
//! a board. The format is in `docsync::database_page`.

use docsync::Workspace;
use docsync::database_page::{DatabasePage, Sort, View, ViewType};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::{AppState, CmdResult, blocking, text};
use crate::devlog;

/// What a database page shows, sent with the page.
#[derive(Debug, Serialize)]
pub struct DatabasePageInfo {
    /// The database, or `None` while the user is choosing one.
    id: Option<String>,
    /// Whether that database exists: it may have been deleted elsewhere.
    exists: bool,
    /// In tab order; never empty.
    views: Vec<ViewInfo>,
}

/// A view as the window sends and receives it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewInfo {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    position: Option<f64>,
    sort: Option<SortInfo>,
    group_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SortInfo {
    column: String,
    /// "asc" or "desc".
    direction: String,
}

impl From<&View> for ViewInfo {
    fn from(view: &View) -> ViewInfo {
        ViewInfo {
            id: view.id.clone(),
            name: view.name.clone(),
            kind: view.kind.as_str().to_string(),
            position: view.position,
            sort: view.sort.as_ref().map(|s| SortInfo {
                column: s.column.clone(),
                direction: if s.descending { "desc" } else { "asc" }.into(),
            }),
            group_by: view.group_by.clone(),
        }
    }
}

impl TryFrom<ViewInfo> for View {
    type Error = String;

    fn try_from(info: ViewInfo) -> CmdResult<View> {
        let kind =
            ViewType::parse(&info.kind).ok_or_else(|| format!("“{}” isn't a kind of view.", info.kind))?;
        let name = info.name.trim();
        if name.is_empty() {
            return Err("A view needs a name.".into());
        }
        Ok(View {
            id: info.id,
            name: name.to_string(),
            kind,
            position: info.position.filter(|p| p.is_finite()),
            sort: info.sort.map(|s| Sort {
                column: s.column,
                descending: s.direction == "desc",
            }),
            group_by: info.group_by.filter(|g| !g.is_empty()),
        })
    }
}

/// The page's meta.json read as a database page, for `read_page`.
pub fn info(ws: &Workspace, meta: &serde_json::Value) -> Option<DatabasePageInfo> {
    let page = DatabasePage::from_meta(meta)?;
    Some(DatabasePageInfo {
        exists: page.database.as_deref().is_some_and(|db| ws.database_exists(db)),
        id: page.database,
        views: page.views.iter().map(ViewInfo::from).collect(),
    })
}

/// A new database page. In a workspace without databases it gets a new one
/// named after it at once; otherwise the page asks which to show.
fn create(ws: &Workspace, title: &str, parent: Option<&str>) -> CmdResult<String> {
    let database = if ws.list_databases().map_err(text)?.is_empty() {
        Some(crate::databases::create(
            ws,
            if title.trim().is_empty() {
                "Untitled"
            } else {
                title
            },
        )?)
    } else {
        None
    };
    ws.create_database_page(title, parent, database.as_deref())
        .map_err(text)
}

#[tauri::command]
pub async fn create_database_page(
    state: State<'_, AppState>,
    title: String,
    parent: Option<String>,
) -> CmdResult<String> {
    let (engine, edited) = state.engine()?;
    blocking("create_database_page", move || {
        let id = create(&Workspace::new(engine.root()), &title, parent.as_deref())?;
        devlog::info("app", format!("Created database page {id}"));
        edited();
        Ok(id)
    })
    .await
}

/// Show `database` on the page.
#[tauri::command]
pub async fn set_page_database(state: State<'_, AppState>, id: String, database: String) -> CmdResult<()> {
    let (engine, edited) = state.engine()?;
    blocking("set_page_database", move || {
        let ws = Workspace::new(engine.root());
        if !ws.database_exists(&database) {
            return Err("This database no longer exists.".into());
        }
        ws.set_page_database(&id, &database).map_err(text)?;
        devlog::info("app", format!("Page {id} shows database {database}"));
        edited();
        Ok(())
    })
    .await
}

/// Add or change a view of a database page, or remove it with `view` null.
#[tauri::command]
pub async fn set_page_view(
    state: State<'_, AppState>,
    id: String,
    view_id: String,
    view: Option<ViewInfo>,
) -> CmdResult<()> {
    let view = view.map(View::try_from).transpose()?;
    let (engine, edited) = state.engine()?;
    blocking("set_page_view", move || {
        Workspace::new(engine.root())
            .set_page_view(&id, &view_id, view.as_ref())
            .map_err(text)?;
        devlog::debug(
            "app",
            format!(
                "Page {id}: {} view {view_id}",
                if view.is_some() { "changed" } else { "removed" }
            ),
        );
        edited();
        Ok(())
    })
    .await
}

/// The database a page shows, when no page outside `deleting` (the pages
/// being deleted with it) shows it: deleting the page deletes it too, as the
/// page is where people see it.
pub fn database_to_delete_with(ws: &Workspace, page: &str, deleting: &[String]) -> Option<String> {
    let meta = ws.read_page_meta(page).ok()?;
    let database = DatabasePage::from_meta(&meta)?.database?;
    let others = ws.pages_showing(&database).ok()?;
    (others.iter().all(|p| p == page || deleting.contains(p)) && ws.database_exists(&database))
        .then_some(database)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_first_database_page_gets_a_database_and_later_ones_ask() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path());
        let first = create(&ws, "Tasks", None).unwrap();
        let shown = info(&ws, &ws.read_page_meta(&first).unwrap()).unwrap();
        assert!(shown.exists);
        assert_eq!(
            ws.read_schema(shown.id.as_deref().unwrap()).unwrap().name,
            "Tasks"
        );
        assert_eq!(shown.views.len(), 1);

        let second = create(&ws, "", None).unwrap();
        let shown = info(&ws, &ws.read_page_meta(&second).unwrap()).unwrap();
        assert_eq!((shown.id, shown.exists), (None, false));
        assert!(info(&ws, &serde_json::json!({"title": "plain"})).is_none());
    }

    #[test]
    fn a_database_is_deleted_with_the_last_page_showing_it() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path());
        let a = create(&ws, "A", None).unwrap();
        let db = DatabasePage::from_meta(&ws.read_page_meta(&a).unwrap())
            .unwrap()
            .database
            .unwrap();
        assert_eq!(
            database_to_delete_with(&ws, &a, &[]).as_deref(),
            Some(db.as_str())
        );
        let b = ws.create_database_page("B", None, Some(&db)).unwrap();
        assert_eq!(database_to_delete_with(&ws, &a, &[]), None);
        assert_eq!(database_to_delete_with(&ws, &b, &[]), None);
        // Unless the other page goes too.
        assert_eq!(
            database_to_delete_with(&ws, &a, std::slice::from_ref(&b)).as_deref(),
            Some(db.as_str())
        );
        let plain = ws.create_page("Plain", None).unwrap();
        assert_eq!(database_to_delete_with(&ws, &plain, &[]), None);
    }

    #[test]
    fn views_from_the_window_are_checked() {
        let view = |kind: &str, name: &str| ViewInfo {
            id: "v".into(),
            name: name.into(),
            kind: kind.into(),
            position: Some(f64::NAN),
            sort: None,
            group_by: Some(String::new()),
        };
        let ok = View::try_from(view("board", " Sprint ")).unwrap();
        assert_eq!(
            (ok.name.as_str(), ok.position, ok.group_by),
            ("Sprint", None, None)
        );
        assert!(View::try_from(view("calendar", "x")).is_err());
        assert!(View::try_from(view("table", " ")).is_err());
    }
}
