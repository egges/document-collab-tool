//! The page list the sidebar shows.

use std::collections::{HashMap, HashSet};

use docsync::Workspace;
use docsync::database_page::DatabasePage;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PageSummary {
    pub id: String,
    pub title: String,
    /// The parent page, or `None` for a top-level page. Never points at a
    /// page that doesn't exist.
    pub parent: Option<String>,
    /// "page", "database" for a page that shows a database, or "row" for
    /// a database's row.
    pub kind: &'static str,
    /// The database a database page shows, once chosen.
    pub database: Option<String>,
}

/// Every page, sorted by title, with orphans moved to the top level.
pub fn list_pages(ws: &Workspace) -> docsync::Result<Vec<PageSummary>> {
    let mut pages = Vec::new();
    for id in ws.list_pages()? {
        // A hand-edited meta.json may not parse. Show the page anyway, so it
        // can still be opened and fixed.
        let meta = ws.read_page_meta(&id).unwrap_or_default();
        let database = DatabasePage::from_meta(&meta);
        pages.push(PageSummary {
            title: meta["title"].as_str().unwrap_or_default().to_string(),
            parent: meta["parent"].as_str().map(str::to_string),
            kind: if database.is_some() { "database" } else { "page" },
            database: database.and_then(|d| d.database),
            id,
        });
    }
    // Rows are pages too: under the first page that shows their database,
    // for the breadcrumb and search. The sidebar leaves them out.
    let mut shown_on: HashMap<String, String> = HashMap::new();
    for page in &pages {
        if let Some(db) = &page.database {
            shown_on.entry(db.clone()).or_insert_with(|| page.id.clone());
        }
    }
    for db in ws.list_databases()? {
        let Ok(schema) = ws.read_schema(&db) else { continue };
        let title = schema.title_column().map(|c| c.id.clone());
        for row in ws.read_rows(&db)? {
            pages.push(PageSummary {
                title: title
                    .as_ref()
                    .and_then(|c| row.cells.get(c))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                parent: shown_on.get(&db).cloned(),
                kind: "row",
                database: Some(db.clone()),
                id: row.id,
            });
        }
    }
    normalize_parents(&mut pages);
    pages.sort_by(|a, b| (a.title.to_lowercase(), &a.id).cmp(&(b.title.to_lowercase(), &b.id)));
    Ok(pages)
}

/// Move a page to the top level when its parent doesn't exist (deleted on
/// another device while this page was edited: sync restores the page but not
/// the parent) or when it's part of a cycle (a hand edit made pages each
/// other's parents). Children of such a page stay under it.
pub fn normalize_parents(pages: &mut [PageSummary]) {
    let parents: HashMap<&str, Option<&str>> = pages
        .iter()
        .map(|p| (p.id.as_str(), p.parent.as_deref()))
        .collect();
    let on_cycle = |start: &str| {
        let mut seen = HashSet::new();
        let mut current = start;
        while let Some(Some(parent)) = parents.get(current) {
            if *parent == start {
                return true;
            }
            if !seen.insert(*parent) {
                return false; // a cycle further up, not through `start`
            }
            current = parent;
        }
        false
    };
    let orphans: HashSet<String> = pages
        .iter()
        .filter(|p| match p.parent.as_deref() {
            None => false,
            Some(parent) => !parents.contains_key(parent) || on_cycle(&p.id),
        })
        .map(|p| p.id.clone())
        .collect();
    for page in pages.iter_mut() {
        if orphans.contains(&page.id) {
            page.parent = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(id: &str, parent: Option<&str>) -> PageSummary {
        PageSummary {
            id: id.into(),
            title: id.into(),
            parent: parent.map(Into::into),
            kind: "page",
            database: None,
        }
    }

    fn parents(pages: &[PageSummary]) -> Vec<(&str, Option<&str>)> {
        pages
            .iter()
            .map(|p| (p.id.as_str(), p.parent.as_deref()))
            .collect()
    }

    #[test]
    fn keeps_a_valid_tree() {
        let mut pages = vec![page("a", None), page("b", Some("a")), page("c", Some("b"))];
        normalize_parents(&mut pages);
        assert_eq!(parents(&pages), [("a", None), ("b", Some("a")), ("c", Some("b"))]);
    }

    #[test]
    fn moves_orphans_and_their_children_stay_put() {
        // "gone" was deleted; b is restored without it, c is b's child.
        let mut pages = vec![page("b", Some("gone")), page("c", Some("b"))];
        normalize_parents(&mut pages);
        assert_eq!(parents(&pages), [("b", None), ("c", Some("b"))]);
    }

    #[test]
    fn breaks_cycles() {
        let mut pages = vec![
            page("a", Some("b")),
            page("b", Some("a")),
            page("c", Some("c")),
            page("d", Some("a")),
        ];
        normalize_parents(&mut pages);
        assert_eq!(
            parents(&pages),
            [("a", None), ("b", None), ("c", None), ("d", Some("a"))]
        );
    }

    #[test]
    fn lists_pages_sorted_by_title() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path());
        let b = ws.create_page("beta", None).unwrap();
        let a = ws.create_page("Alpha", Some(&b)).unwrap();
        let orphan = ws.create_page("gamma", Some("deleted")).unwrap();
        let pages = list_pages(&ws).unwrap();
        assert_eq!(
            parents(&pages),
            [
                (a.as_str(), Some(b.as_str())),
                (b.as_str(), None),
                (orphan.as_str(), None)
            ]
        );
        assert_eq!(pages[0].title, "Alpha");
    }

    #[test]
    fn rows_are_listed_under_the_page_that_shows_their_database() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path());
        let db = ws.create_database("Tasks", &["name"]).unwrap();
        let mut cells = serde_json::Map::new();
        cells.insert("name".into(), "Plan".into());
        let row = ws.add_row(&db, cells).unwrap();
        let shown = ws.create_database_page("Tasks", None, Some(&db)).unwrap();
        let pages = list_pages(&ws).unwrap();
        let listed = pages.iter().find(|p| p.id == row).unwrap();
        assert_eq!((listed.title.as_str(), listed.kind), ("Plan", "row"));
        assert_eq!(listed.parent.as_deref(), Some(shown.as_str()));
    }
}
