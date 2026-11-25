//! Importing Markdown files and folders as pages: notes from Obsidian, a
//! Notion export, a `docs/` folder, or a few loose files.
//!
//! - Each `.md` file becomes a page. Its front matter moves into meta.json
//!   (see [`crate::front_matter`]). The title comes from the front matter,
//!   else from a `# Heading` on the first line (which is then removed, since
//!   the page shows its title above the text), else from the file name.
//! - A folder becomes a page with the folder's contents inside it. A folder
//!   next to a file of the same name (`Trip.md` and `Trip/`, as Notion
//!   exports subpages) holds that page's subpages instead. Folders without
//!   any Markdown in them (attachments, say) don't become pages.
//! - Links between imported files, written either way (`[text](other.md)`
//!   or Obsidian's `[[other]]`), are rewritten to point at the new pages, as
//!   `../<id>/page.md`. Images and other files a page links to are copied
//!   into the page's `assets/` folder, but only from inside what was chosen
//!   to import, so a page can't pull in files from elsewhere on the disk.
//! - Files and folders whose names start with `.` (`.obsidian`, `.git`) and
//!   symbolic links are skipped.
//!
//! Pages keep their Markdown as written: the editor rewrites a page in its
//! house style on the first real edit, like any other page.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use percent_encoding::{AsciiSet, CONTROLS, percent_decode_str, utf8_percent_encode};
use serde_json::Map;

use crate::error::IoContext;
use crate::workspace::{Workspace, new_id};
use crate::{Error, Result, front_matter};

/// What an import created.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportReport {
    /// The pages made for what was chosen, in order (their subpages aren't
    /// listed). The app opens the first.
    pub pages: Vec<String>,
    /// Pages created, subpages included.
    pub page_count: usize,
    /// Images and other files copied into pages' `assets/` folders.
    pub asset_count: usize,
    /// Files that couldn't be imported: chosen files that aren't Markdown,
    /// and Markdown that couldn't be read as text (that page is created
    /// empty, so its subpages still have a place).
    pub skipped: Vec<PathBuf>,
}

/// Import `sources` (Markdown files and folders) as pages under `parent`,
/// or at the top level. Doesn't commit.
pub fn import_markdown(ws: &Workspace, sources: &[PathBuf], parent: Option<&str>) -> Result<ImportReport> {
    if let Some(parent) = parent
        && !ws.page_exists(parent)
    {
        return Err(Error::InvalidData {
            path: parent.to_string(),
            message: "the page to import into no longer exists".into(),
        });
    }
    let mut index = Index::default();
    let mut report = ImportReport::default();
    let mut nodes = Vec::new();
    for source in sources {
        let Ok(path) = fs::canonicalize(source) else {
            report.skipped.push(source.clone());
            continue;
        };
        let meta = fs::metadata(&path).at(&path)?;
        if meta.is_dir() {
            let root = index.add_root(path.clone());
            let children = index.scan(&path, root, &mut report.skipped);
            if !children.is_empty() {
                nodes.push(Node {
                    id: new_id(),
                    file: None,
                    folder: Some(path),
                    root,
                    children,
                });
            }
        } else if is_markdown(&path) {
            let root = index.add_root(path.parent().map(Path::to_path_buf).unwrap_or_default());
            nodes.push(index.file_node(path, None, root, &mut report.skipped));
        } else {
            report.skipped.push(path);
        }
    }
    for node in &nodes {
        index.register(node);
    }
    for node in &nodes {
        report.pages.push(node.id.clone());
        write_node(ws, &index, node, parent, &mut report)?;
    }
    Ok(report)
}

/// A page to create: a Markdown file, a folder, or a file with a folder of
/// subpages.
struct Node {
    id: String,
    file: Option<PathBuf>,
    folder: Option<PathBuf>,
    /// Index into [`Index::roots`]: the folder this node was found in.
    root: usize,
    children: Vec<Node>,
}

/// Everything being imported, to resolve links between files.
#[derive(Default)]
struct Index {
    /// The folders chosen (or the folder a chosen file is in). Links can
    /// only copy files from inside these.
    roots: Vec<PathBuf>,
    /// Markdown file → its page.
    pages: HashMap<PathBuf, String>,
    /// The same, lowercased, for links that differ only in case.
    pages_lower: HashMap<String, String>,
    /// For `[[name]]`: lowercased file stem → (file, page).
    by_stem: HashMap<String, Vec<(PathBuf, String)>>,
    /// For `[[folder/name]]`: lowercased path from the root, without `.md`.
    by_path: HashMap<String, String>,
    /// For `![[image.png]]`: lowercased file name → files found while
    /// scanning, other than Markdown.
    files_by_name: HashMap<String, Vec<PathBuf>>,
}

impl Index {
    fn add_root(&mut self, path: PathBuf) -> usize {
        self.roots.push(path);
        self.roots.len() - 1
    }

    /// The pages in `dir`, and the other files in it for `![[...]]`.
    fn scan(&mut self, dir: &Path, root: usize, skipped: &mut Vec<PathBuf>) -> Vec<Node> {
        let Ok(entries) = fs::read_dir(dir) else {
            skipped.push(dir.to_path_buf());
            return Vec::new();
        };
        let mut files = Vec::new();
        let mut folders = Vec::new();
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() {
                folders.push(path);
            } else if kind.is_file() {
                if is_markdown(&path) {
                    files.push(path);
                } else {
                    let key = name.to_string_lossy().to_lowercase();
                    self.files_by_name.entry(key).or_default().push(path);
                }
            }
        }
        let mut nodes = Vec::new();
        for file in files {
            // `Trip.md` next to `Trip/`: the folder holds Trip's subpages.
            let stem = file.file_stem().map(|s| s.to_os_string());
            let sub = folders
                .iter()
                .position(|f| f.file_name().map(|n| n.to_os_string()) == stem)
                .map(|i| folders.remove(i));
            nodes.push(self.file_node(file, sub, root, skipped));
        }
        for folder in folders {
            let children = self.scan(&folder, root, skipped);
            if !children.is_empty() {
                nodes.push(Node {
                    id: new_id(),
                    file: None,
                    folder: Some(folder),
                    root,
                    children,
                });
            }
        }
        nodes
    }

    fn file_node(
        &mut self,
        file: PathBuf,
        folder: Option<PathBuf>,
        root: usize,
        skipped: &mut Vec<PathBuf>,
    ) -> Node {
        let children = match &folder {
            Some(folder) => self.scan(folder, root, skipped),
            None => Vec::new(),
        };
        Node {
            id: new_id(),
            file: Some(file),
            folder,
            root,
            children,
        }
    }

    /// Record `node` and its subpages so links can find them.
    fn register(&mut self, node: &Node) {
        if let Some(file) = &node.file {
            self.pages.insert(file.clone(), node.id.clone());
            self.pages_lower
                .insert(file.to_string_lossy().to_lowercase(), node.id.clone());
            if let Some(stem) = file.file_stem() {
                self.by_stem
                    .entry(stem.to_string_lossy().to_lowercase())
                    .or_default()
                    .push((file.clone(), node.id.clone()));
            }
            if let Ok(relative) = file.with_extension("").strip_prefix(&self.roots[node.root]) {
                let key = relative.to_string_lossy().replace('\\', "/").to_lowercase();
                self.by_path.entry(key).or_insert_with(|| node.id.clone());
            }
        }
        for child in &node.children {
            self.register(child);
        }
    }

    fn page_for(&self, path: &Path) -> Option<&String> {
        self.pages
            .get(path)
            .or_else(|| self.pages_lower.get(&path.to_string_lossy().to_lowercase()))
    }
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
}

fn write_node(
    ws: &Workspace,
    index: &Index,
    node: &Node,
    parent: Option<&str>,
    report: &mut ImportReport,
) -> Result<()> {
    let name = node
        .file
        .as_deref()
        .and_then(Path::file_stem)
        .or_else(|| node.folder.as_deref().and_then(Path::file_name))
        .map(|n| title_from_name(&n.to_string_lossy()))
        .unwrap_or_default();
    let mut title = name;
    let mut properties = Map::new();
    let mut body = String::new();
    let mut assets = Assets::default();
    if let Some(file) = &node.file {
        match fs::read_to_string(file) {
            Ok(text) => {
                let text = text
                    .strip_prefix('\u{feff}')
                    .unwrap_or(&text)
                    .replace("\r\n", "\n");
                let mut titled = false;
                let mut text = match front_matter::parse(&text) {
                    Some(front) => {
                        properties = front.properties;
                        if let Some(t) = front.title {
                            title = t;
                            titled = true;
                        }
                        front.body
                    }
                    None => text,
                };
                if !titled && let Some((heading, rest)) = leading_heading(&text) {
                    title = heading;
                    text = rest;
                }
                let mut links = Links {
                    index,
                    dir: file.parent().unwrap_or(Path::new("")),
                    root: &index.roots[node.root],
                    assets: &mut assets,
                };
                body = rewrite_links(&text, &mut links);
            }
            Err(_) => report.skipped.push(file.clone()),
        }
    }
    let body = body.trim_end();
    let body = if body.is_empty() {
        String::new()
    } else {
        format!("{body}\n")
    };
    ws.create_page_with(&node.id, &title, parent, properties, &body)?;
    report.page_count += 1;
    if !assets.copies.is_empty() {
        let dir = ws.page_assets_dir(&node.id);
        fs::create_dir_all(&dir).at(&dir)?;
        for (source, name) in &assets.copies {
            let target = dir.join(name);
            fs::copy(source, &target).at(&target)?;
            report.asset_count += 1;
        }
    }
    for child in &node.children {
        write_node(ws, index, child, Some(&node.id), report)?;
    }
    Ok(())
}

/// A page title from a file or folder name. Notion adds a 32-character id
/// to each name in an export ("Trip 1a2b…"), which is dropped.
fn title_from_name(name: &str) -> String {
    let name = name.trim();
    if let Some((title, id)) = name.rsplit_once(' ')
        && id.len() == 32
        && id.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return title.trim().to_string();
    }
    name.to_string()
}

/// `# Title` on the first line: the title, and the text after it.
fn leading_heading(text: &str) -> Option<(String, String)> {
    let text = text.trim_start_matches('\n');
    let (line, rest) = text.split_once('\n').unwrap_or((text, ""));
    let heading = line.strip_prefix("# ")?.trim().trim_end_matches('#').trim();
    if heading.is_empty() {
        return None;
    }
    Some((heading.to_string(), rest.trim_start_matches('\n').to_string()))
}

/// Files a page links to, copied into its `assets/` folder.
#[derive(Default)]
struct Assets {
    /// Source file → its name in `assets/`, in the order found.
    copies: Vec<(PathBuf, String)>,
    names: HashSet<String>,
}

impl Assets {
    /// The name `source` gets in `assets/`: its own, or with `-2`, `-3`, …
    /// when another file already took it.
    fn add(&mut self, source: PathBuf) -> String {
        if let Some((_, name)) = self.copies.iter().find(|(s, _)| *s == source) {
            return name.clone();
        }
        let file_name = source
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".into());
        let (stem, ext) = match file_name.rfind('.') {
            Some(i) if i > 0 => (&file_name[..i], &file_name[i..]),
            _ => (file_name.as_str(), ""),
        };
        let mut name = file_name.clone();
        let mut n = 2;
        while !self.names.insert(name.to_lowercase()) {
            name = format!("{stem}-{n}{ext}");
            n += 1;
        }
        self.copies.push((source, name.clone()));
        name
    }
}

/// Characters to escape in a link to a file in `assets/`.
const PATH_UNSAFE: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'(')
    .add(b')')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'[')
    .add(b']')
    .add(b'\\')
    .add(b'`');

/// Resolves the links in one page.
struct Links<'a> {
    index: &'a Index,
    /// The folder the page's file is in.
    dir: &'a Path,
    /// Files may only be copied from inside this folder.
    root: &'a Path,
    assets: &'a mut Assets,
}

impl Links<'_> {
    /// The new address for a Markdown link's destination, if it points at
    /// an imported page or a file to copy.
    fn destination(&mut self, dest: &str) -> Option<String> {
        if dest.is_empty() || dest.starts_with('#') || dest.starts_with('/') || has_scheme(dest) {
            return None;
        }
        let end = dest.find(['?', '#']).unwrap_or(dest.len());
        let fragment = dest[end..].find('#').map(|i| &dest[end + i..]).unwrap_or("");
        let path = percent_decode_str(&dest[..end]).decode_utf8().ok()?;
        let target = normalize(&self.dir.join(path.as_ref()));
        if let Some(id) = self.index.page_for(&target) {
            return Some(format!("../{id}/page.md{fragment}"));
        }
        if is_markdown(&target) {
            return None;
        }
        self.asset(&target)
    }

    /// Copy `target` into the page's assets, if it's a file inside the root.
    fn asset(&mut self, target: &Path) -> Option<String> {
        let real = fs::canonicalize(target).ok()?;
        let inside = real.strip_prefix(self.root).ok()?;
        let hidden = inside
            .components()
            .any(|c| c.as_os_str().to_string_lossy().starts_with('.'));
        if hidden || !real.is_file() {
            return None;
        }
        let name = self.assets.add(real);
        Some(format!("assets/{}", utf8_percent_encode(&name, PATH_UNSAFE)))
    }

    /// Markdown for an Obsidian link, `[[target]]`, `[[target|text]]` or
    /// `[[target#heading]]`, or an embed (`![[image.png]]`).
    fn wikilink(&mut self, inner: &str, embed: bool) -> Option<String> {
        let (target, alias) = match inner.split_once('|') {
            Some((t, a)) => (t.trim_end_matches('\\').trim(), Some(a.trim())),
            None => (inner.trim(), None),
        };
        let (name, heading) = match target.split_once('#') {
            Some((n, h)) => (n.trim(), Some(h.trim())),
            None => (target, None),
        };
        if name.is_empty() {
            return None;
        }
        let path = Path::new(name);
        if path.extension().is_some() && !is_markdown(path) {
            let file_name = path.file_name()?.to_string_lossy().to_lowercase();
            let candidates = self.index.files_by_name.get(&file_name)?;
            let source = candidates
                .iter()
                .find(|c| c.starts_with(self.root) && c.ends_with(path))
                .or_else(|| candidates.iter().find(|c| c.starts_with(self.root)))?
                .clone();
            let address = self.asset(&source)?;
            let label = alias.filter(|a| !is_size(a));
            return Some(if embed {
                format!("![{}]({address})", escape(label.unwrap_or("")))
            } else {
                format!("[{}]({address})", escape(label.unwrap_or(name)))
            });
        }
        let key = name.strip_suffix(".md").unwrap_or(name).to_lowercase();
        let id = if key.contains('/') {
            self.index.by_path.get(&key)?
        } else {
            let found = self.index.by_stem.get(&key)?;
            &found
                .iter()
                .find(|(file, _)| file.parent() == Some(self.dir))
                .unwrap_or(&found[0])
                .1
        };
        let shown = name.rsplit('/').next().unwrap_or(name);
        let text = alias.map(str::to_string).unwrap_or_else(|| match heading {
            Some(h) if !h.is_empty() => format!("{shown} › {h}"),
            _ => shown.to_string(),
        });
        Some(format!("[{}](../{id}/page.md)", escape(&text)))
    }
}

/// `300` or `300x200`: an Obsidian image size, not a caption.
fn is_size(text: &str) -> bool {
    !text.is_empty()
        && text
            .split('x')
            .all(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

fn escape(text: &str) -> String {
    text.replace('[', "\\[").replace(']', "\\]")
}

fn has_scheme(dest: &str) -> bool {
    let Some(colon) = dest.find(':') else { return false };
    let scheme = &dest[..colon];
    scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
}

/// `a/./b/../c` → `a/c`, without touching the disk.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// Rewrite the links in a page, leaving code blocks and code spans alone.
fn rewrite_links(text: &str, links: &mut Links) -> String {
    let mut out = String::with_capacity(text.len());
    let mut fence: Option<(u8, usize)> = None;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start_matches(' ');
        let indented = line.len() - trimmed.len() >= 4;
        let marker = trimmed.bytes().next().filter(|b| *b == b'`' || *b == b'~');
        let run = marker.map_or(0, |m| trimmed.bytes().take_while(|b| *b == m).count());
        if let Some((m, n)) = fence {
            if !indented && marker == Some(m) && run >= n && trimmed[run..].trim().is_empty() {
                fence = None;
            }
            out.push_str(line);
            continue;
        }
        if !indented && run >= 3 {
            fence = Some((marker.unwrap_or(b'`'), run));
            out.push_str(line);
            continue;
        }
        if !indented && let Some(rewritten) = rewrite_definition(line, links) {
            out.push_str(&rewritten);
            continue;
        }
        rewrite_inline(line, links, &mut out);
    }
    out
}

/// A link reference definition, `[label]: destination "title"`.
fn rewrite_definition(line: &str, links: &mut Links) -> Option<String> {
    let start = line.len() - line.trim_start().len();
    let rest = line[start..].strip_prefix('[')?;
    let close = rest.find("]:")?;
    if rest[..close].starts_with('[') || rest[..close].starts_with('^') {
        return None; // a wikilink or a footnote
    }
    let after = &rest[close + 2..];
    let dest_start = after.len() - after.trim_start().len();
    let dest = &after[dest_start..];
    let (dest, bracketed) = match dest.strip_prefix('<') {
        Some(d) => (&d[..d.find('>')?], true),
        None => (
            &dest[..dest.find(char::is_whitespace).unwrap_or(dest.len())],
            false,
        ),
    };
    let new = links.destination(dest)?;
    let prefix_len = start + 1 + close + 2 + dest_start + usize::from(bracketed);
    let suffix = &line[prefix_len + dest.len()..];
    Some(format!("{}{new}{suffix}", &line[..prefix_len]))
}

/// Rewrite `](destination)` links and `[[wikilinks]]` in one line.
fn rewrite_inline(line: &str, links: &mut Links, out: &mut String) {
    let bytes = line.as_bytes();
    let mut i = 0;
    let mut copied = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'`' => {
                // A code span ends at the next run of exactly as many backticks.
                let run = bytes[i..].iter().take_while(|b| **b == b'`').count();
                let mut j = i + run;
                i = loop {
                    let Some(k) = line[j..].find('`').map(|k| j + k) else {
                        break i + run;
                    };
                    let other = bytes[k..].iter().take_while(|b| **b == b'`').count();
                    if other == run {
                        break k + other;
                    }
                    j = k + other;
                };
            }
            b'!' | b'[' if line[i..].starts_with("[[") || line[i..].starts_with("![[") => {
                let embed = bytes[i] == b'!';
                let open = i + if embed { 3 } else { 2 };
                let Some(len) = line[open..].find("]]") else {
                    i = open;
                    continue;
                };
                let end = open + len + 2;
                if let Some(new) = links.wikilink(&line[open..open + len], embed) {
                    out.push_str(&line[copied..i]);
                    out.push_str(&new);
                    copied = end;
                }
                i = end;
            }
            b']' if bytes.get(i + 1) == Some(&b'(') => {
                let start = i + 2;
                let Some((dest_start, dest_end)) = inline_destination(line, start) else {
                    i = start;
                    continue;
                };
                if let Some(new) = links.destination(&line[dest_start..dest_end]) {
                    out.push_str(&line[copied..dest_start]);
                    out.push_str(&new);
                    copied = dest_end;
                }
                i = dest_end;
            }
            _ => i += 1,
        }
    }
    out.push_str(&line[copied.min(line.len())..]);
}

/// Where the destination of an inline link starts and ends, `start` being
/// just after `](`. Handles `<with spaces>` and balanced parentheses.
fn inline_destination(line: &str, start: usize) -> Option<(usize, usize)> {
    let bytes = line.as_bytes();
    let mut i = start;
    while bytes.get(i) == Some(&b' ') {
        i += 1;
    }
    if bytes.get(i) == Some(&b'<') {
        let end = line[i + 1..].find('>')? + i + 1;
        return Some((i + 1, end));
    }
    let begin = i;
    let mut depth = 0;
    while let Some(&b) = bytes.get(i) {
        match b {
            b'(' => depth += 1,
            b')' if depth == 0 => break,
            b')' => depth -= 1,
            b'\\' => i += 1,
            b if b.is_ascii_whitespace() => break,
            _ => {}
        }
        i += 1;
    }
    (i > begin).then_some((begin, i.min(line.len())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write(root: &Path, path: &str, content: &str) {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    struct Imported {
        ws: Workspace,
        report: ImportReport,
        _dirs: (tempfile::TempDir, tempfile::TempDir),
    }

    impl Imported {
        fn page(&self, title: &str) -> (String, serde_json::Value, String) {
            for id in self.ws.list_pages().unwrap() {
                let meta = self.ws.read_page_meta(&id).unwrap();
                if meta["title"] == title {
                    let body = self.ws.read_body(&id).unwrap();
                    return (id, meta, body);
                }
            }
            panic!("no page titled {title:?}");
        }
    }

    fn import(files: &[(&str, &str)], choose: &[&str]) -> Imported {
        let source = tempfile::tempdir().unwrap();
        for (path, content) in files {
            write(source.path(), path, content);
        }
        let target = tempfile::tempdir().unwrap();
        let ws = Workspace::new(target.path());
        let sources: Vec<PathBuf> = choose.iter().map(|c| source.path().join(c)).collect();
        let report = import_markdown(&ws, &sources, None).unwrap();
        Imported {
            ws,
            report,
            _dirs: (source, target),
        }
    }

    #[test]
    fn front_matter_moves_into_meta() {
        let out = import(
            &[(
                "trip.md",
                "---\ntitle: Trip to Lisbon\ntags: [travel]\n---\n\nDay one.\n",
            )],
            &["trip.md"],
        );
        let (id, meta, body) = out.page("Trip to Lisbon");
        assert_eq!(meta["properties"], json!({"tags": ["travel"]}));
        assert_eq!(meta["parent"], json!(null));
        assert_eq!(body, "Day one.\n");
        assert_eq!(out.report.pages, vec![id]);
        assert_eq!(out.report.page_count, 1);
    }

    #[test]
    fn title_from_heading_or_file_name() {
        let out = import(
            &[
                ("a.md", "# Heading title\n\nText\n"),
                ("Plain note.md", "Text without heading\r\n"),
                ("Notion page 0123456789abcdef0123456789abcdef.md", "Text\n"),
            ],
            &[
                "a.md",
                "Plain note.md",
                "Notion page 0123456789abcdef0123456789abcdef.md",
            ],
        );
        assert_eq!(out.page("Heading title").2, "Text\n");
        assert_eq!(out.page("Plain note").2, "Text without heading\n");
        out.page("Notion page");
    }

    #[test]
    fn folders_become_pages_and_notion_folders_hold_subpages() {
        let out = import(
            &[
                ("Vault/Projects/Alpha.md", "Alpha\n"),
                ("Vault/Trip.md", "Trip\n"),
                ("Vault/Trip/Day 1.md", "Day\n"),
                ("Vault/attachments/photo.png", "png"),
                ("Vault/.obsidian/app.md", "hidden\n"),
            ],
            &["Vault"],
        );
        let (vault, _, _) = out.page("Vault");
        let (projects, meta, _) = out.page("Projects");
        assert_eq!(meta["parent"], json!(vault));
        assert_eq!(out.page("Alpha").1["parent"], json!(projects));
        let (trip, meta, _) = out.page("Trip");
        assert_eq!(meta["parent"], json!(vault));
        assert_eq!(out.page("Day 1").1["parent"], json!(trip));
        assert_eq!(out.report.page_count, 5); // no "attachments", no ".obsidian"
        assert_eq!(out.report.pages, vec![vault]);
    }

    #[test]
    fn links_between_files_point_at_the_new_pages() {
        let out = import(
            &[
                (
                    "notes/a.md",
                    "See [B](b.md#part), [B again](./b.md) and [out](https://x.com/b.md).\n\n[ref]: <sub dir/c.md>\n",
                ),
                (
                    "notes/b.md",
                    "Back to [[a]], [[sub dir/c|C page]] and [[missing]].\n\n```\n[[a]] [x](b.md)\n```\n`[[a]]`\n",
                ),
                (
                    "notes/sub dir/c.md",
                    "[A](../a.md) [encoded](../sub%20dir/c.md)\n",
                ),
            ],
            &["notes"],
        );
        let (a, _, a_body) = out.page("a");
        let (b, _, b_body) = out.page("b");
        let (c, _, c_body) = out.page("c");
        assert_eq!(
            a_body,
            format!(
                "See [B](../{b}/page.md#part), [B again](../{b}/page.md) and [out](https://x.com/b.md).\n\n[ref]: <../{c}/page.md>\n"
            )
        );
        assert_eq!(
            b_body,
            format!(
                "Back to [a](../{a}/page.md), [C page](../{c}/page.md) and [[missing]].\n\n```\n[[a]] [x](b.md)\n```\n`[[a]]`\n"
            )
        );
        assert_eq!(c_body, format!("[A](../{a}/page.md) [encoded](../{c}/page.md)\n"));
    }

    #[test]
    fn linked_files_are_copied_into_assets() {
        let out = import(
            &[
                (
                    "v/note.md",
                    "![photo](img/photo%201.png) ![[diagram.png|300]] ![again](img/photo%201.png)\n[pdf](../outside.pdf) [hidden](.secret/key.txt)\n",
                ),
                ("v/img/photo 1.png", "png"),
                ("v/drawings/diagram.png", "png2"),
                ("v/.secret/key.txt", "secret"),
                ("outside.pdf", "pdf"),
            ],
            &["v"],
        );
        let (id, _, body) = out.page("note");
        assert_eq!(
            body,
            "![photo](assets/photo%201.png) ![](assets/diagram.png) ![again](assets/photo%201.png)\n[pdf](../outside.pdf) [hidden](.secret/key.txt)\n"
        );
        let assets = out.ws.page_assets_dir(&id);
        assert_eq!(fs::read_to_string(assets.join("photo 1.png")).unwrap(), "png");
        assert_eq!(fs::read_to_string(assets.join("diagram.png")).unwrap(), "png2");
        assert_eq!(out.report.asset_count, 2);
    }

    #[test]
    fn text_outside_ascii_is_left_intact() {
        let text = "Café \\é ünïcode [[é]] `ß` ![ü](bild%20ü.png) ](\u{1F600}) [x](<ö.md>)\n";
        let out = import(
            &[("n/ö.md", "x\n"), ("n/é.md", text), ("n/bild ü.png", "png")],
            &["n"],
        );
        let (o, _, _) = out.page("ö");
        let (e, _, body) = out.page("é");
        assert_eq!(
            body,
            format!("Café \\é ünïcode [é](../{e}/page.md) `ß` ![ü](assets/bild%20ü.png) ](\u{1F600}) [x](<../{o}/page.md>)\n")
                .replace("%20ü", "%20%C3%BC")
        );
    }

    #[test]
    fn files_with_the_same_name_get_distinct_asset_names() {
        let mut assets = Assets::default();
        assert_eq!(assets.add(PathBuf::from("/a/img.png")), "img.png");
        assert_eq!(assets.add(PathBuf::from("/b/IMG.png")), "IMG-2.png");
        assert_eq!(assets.add(PathBuf::from("/a/img.png")), "img.png");
    }

    #[test]
    fn other_files_are_reported_as_skipped() {
        let out = import(&[("a.txt", "x")], &["a.txt", "missing.md"]);
        assert_eq!(out.report.page_count, 0);
        assert_eq!(out.report.skipped.len(), 2);
    }

    #[test]
    fn imports_under_a_parent() {
        let source = tempfile::tempdir().unwrap();
        write(source.path(), "a.md", "x\n");
        let target = tempfile::tempdir().unwrap();
        let ws = Workspace::new(target.path());
        let parent = ws.create_page("Inbox", None).unwrap();
        let report = import_markdown(&ws, &[source.path().join("a.md")], Some(&parent)).unwrap();
        assert_eq!(
            ws.read_page_meta(&report.pages[0]).unwrap()["parent"],
            json!(parent)
        );
        assert!(import_markdown(&ws, &[source.path().join("a.md")], Some("gone")).is_err());
    }
}
