//! The page list the sidebar shows.

use std::collections::{HashMap, HashSet};

use docsync::Workspace;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PageSummary {
    pub id: String,
    pub title: String,
    /// The parent page, or `None` for a top-level page. Never points at a
    /// page that doesn't exist.
    pub parent: Option<String>,
}

/// Every page, sorted by title, with orphans moved to the top level.
pub fn list_pages(ws: &Workspace) -> docsync::Result<Vec<PageSummary>> {
    let mut pages = Vec::new();
    for id in ws.list_pages()? {
        // A hand-edited meta.json may not parse. Show the page anyway, so it
        // can still be opened and fixed.
        let meta = ws.read_page_meta(&id).unwrap_or_default();
        pages.push(PageSummary {
            title: meta["title"].as_str().unwrap_or_default().to_string(),
            parent: meta["parent"].as_str().map(str::to_string),
            id,
        });
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
}
