//! Search in page text, for the search palette (⌘K). A plain scan of every
//! page body: fast enough for thousands of pages, until the full-text index
//! on the roadmap replaces it.

use docsync::Workspace;
use serde::Serialize;

/// Characters of context shown on each side of a match.
const CONTEXT: usize = 40;

/// A place in a page's text where the query appears.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TextMatch {
    pub page: String,
    /// The text before the match, the match as written, and the text after,
    /// on one line, so the window can highlight it.
    pub before: String,
    pub matched: String,
    pub after: String,
    /// How many times the query appears in the page.
    pub count: usize,
}

/// Pages whose text contains `query` (ignoring case), at most one match per
/// page and `limit` pages, in page-id order.
pub fn search_text(ws: &Workspace, query: &str, limit: usize) -> docsync::Result<Vec<TextMatch>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let needle: Vec<char> = query.chars().flat_map(char::to_lowercase).collect();
    let mut out = Vec::new();
    // Rows are pages too, so they're in this list.
    for id in ws.list_pages()? {
        let Ok(body) = ws.read_body(&id) else { continue };
        if body.is_empty() {
            continue;
        }
        if let Some(found) = match_in(&body, &needle) {
            out.push(TextMatch { page: id, ..found });
            if out.len() == limit {
                break;
            }
        }
    }
    Ok(out)
}

/// The first match of `needle` (lowercase) in the text of `body` as the
/// editor shows it, with its context, and how many times it appears.
fn match_in(body: &str, needle: &[char]) -> Option<TextMatch> {
    let mut first = None;
    let mut count = 0;
    for line in visible_lines(body) {
        let found = find_all(&line, needle);
        if found.is_empty() {
            continue;
        }
        count += found.len();
        if first.is_none() {
            first = Some((line, found[0]));
        }
    }
    let (line, (start, end)) = first?;
    Some(TextMatch {
        page: String::new(),
        before: tail(line[..start].trim_start(), CONTEXT),
        matched: line[start..end].to_string(),
        after: head(line[end..].trim_end(), CONTEXT),
        count,
    })
}

/// Byte ranges in `line` where `needle` (lowercase) appears, ignoring case.
fn find_all(line: &str, needle: &[char]) -> Vec<(usize, usize)> {
    // Each character of the line, lowercased, with the byte range it came from.
    let mut chars: Vec<(char, usize, usize)> = Vec::new();
    for (at, c) in line.char_indices() {
        let end = at + c.len_utf8();
        for lower in c.to_lowercase() {
            chars.push((lower, at, end));
        }
    }
    let mut found = Vec::new();
    let mut i = 0;
    while i + needle.len() <= chars.len() {
        if chars[i..i + needle.len()]
            .iter()
            .map(|c| c.0)
            .eq(needle.iter().copied())
        {
            found.push((chars[i].1, chars[i + needle.len() - 1].2));
            i += needle.len();
        } else {
            i += 1;
        }
    }
    found
}

/// The page's lines as the editor shows them: no front matter, fences,
/// link addresses, emphasis markers or HTML, so a search finds what the
/// reader sees (and opening the match can select it).
fn visible_lines(body: &str) -> Vec<String> {
    let mut lines = body.lines().peekable();
    let mut out = Vec::new();
    // Front matter.
    if lines.peek().is_some_and(|l| l.trim_end() == "---") {
        lines.next();
        for line in lines.by_ref() {
            if matches!(line.trim_end(), "---" | "...") {
                break;
            }
        }
    }
    let mut fence: Option<String> = None;
    for line in lines {
        let trimmed = line.trim_start();
        if let Some(open) = &fence {
            if trimmed.starts_with(open.as_str())
                && trimmed
                    .trim_start_matches(open.chars().next().unwrap())
                    .trim()
                    .is_empty()
            {
                fence = None;
            } else {
                out.push(line.replace('\t', "    "));
            }
            continue;
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let c = trimmed.chars().next().unwrap();
            fence = Some(trimmed.chars().take_while(|&x| x == c).collect());
            continue;
        }
        if is_reference_definition(trimmed) || is_table_rule(trimmed) {
            continue;
        }
        let text = inline_text(&without_marker(trimmed));
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if !text.is_empty() {
            out.push(text);
        }
    }
    out
}

/// The line without its heading, quote, list or table markers.
fn without_marker(line: &str) -> String {
    let mut line = line.trim_start_matches(['#', '>', ' ']);
    for marker in ["- [ ] ", "- [x] ", "- [X] ", "* [ ] ", "* [x] ", "- ", "* ", "+ "] {
        if let Some(rest) = line.strip_prefix(marker) {
            line = rest;
            break;
        }
    }
    // "1. " or "1) "
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 && (line[digits..].starts_with(". ") || line[digits..].starts_with(") ")) {
        line = &line[digits + 2..];
    }
    if line.starts_with('|') {
        return line
            .trim_matches(|c| c == '|' || c == ' ')
            .replace(" | ", "  ")
            .replace('|', " ");
    }
    line.to_string()
}

/// "[id]: https://…"
fn is_reference_definition(line: &str) -> bool {
    line.starts_with('[') && line.find("]:").is_some_and(|i| !line[1..i].contains(']'))
}

/// "|---|:--:|"
fn is_table_rule(line: &str) -> bool {
    line.contains('-') && line.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '))
}

/// Inline Markdown as text: link and image text without their addresses, no
/// emphasis, code or strikethrough markers, no HTML tags or comments,
/// escapes undone.
fn inline_text(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        match c {
            '\\' if next.is_some_and(|n| n.is_ascii_punctuation()) => {
                out.push(next.unwrap());
                i += 2;
            }
            '!' if next == Some('[') => {
                if let Some((text, end)) = link_at(&chars, i + 1) {
                    out.push_str(&inline_text(&text));
                    i = end;
                } else {
                    out.push(c);
                    i += 1;
                }
            }
            '[' => {
                if let Some((text, end)) = link_at(&chars, i) {
                    out.push_str(&inline_text(&text));
                    i = end;
                } else {
                    out.push(c);
                    i += 1;
                }
            }
            '<' => {
                let rest: String = chars[i..].iter().collect();
                if rest.starts_with("<!--") {
                    i += rest
                        .find("-->")
                        .map_or(rest.chars().count(), |e| rest[..e + 3].chars().count());
                } else if let Some(close) = rest.find('>') {
                    let inner = &rest[1..close];
                    if inner.contains("://") || (inner.contains('@') && !inner.contains(' ')) {
                        out.push_str(inner); // autolink
                        i += rest[..=close].chars().count();
                    } else if inner.starts_with(|c: char| c.is_ascii_alphabetic() || c == '/') {
                        i += rest[..=close].chars().count(); // HTML tag
                    } else {
                        out.push(c);
                        i += 1;
                    }
                } else {
                    out.push(c);
                    i += 1;
                }
            }
            '*' | '`' => i += 1,
            '~' if next == Some('~') => i += 2,
            '_' => {
                // Emphasis only at a word boundary, so snake_case stays.
                let before = i.checked_sub(1).map(|j| chars[j]);
                let inside =
                    before.is_some_and(char::is_alphanumeric) && next.is_some_and(char::is_alphanumeric);
                if inside {
                    out.push(c);
                }
                i += 1;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// A link starting at the "[" at `start`: "[text](address)", "[text][ref]"
/// or "[text][]". Returns the text and the index just past the link.
fn link_at(chars: &[char], start: usize) -> Option<(String, usize)> {
    let close = matching(chars, start, '[', ']')?;
    let text: String = chars[start + 1..close].iter().collect();
    match chars.get(close + 1) {
        Some('(') => Some((text, matching(chars, close + 1, '(', ')')? + 1)),
        Some('[') => Some((text, matching(chars, close + 1, '[', ']')? + 1)),
        _ => None,
    }
}

/// Index of the bracket closing the one at `start`, skipping escaped ones.
fn matching(chars: &[char], start: usize, open: char, close: char) -> Option<usize> {
    let mut depth = 0;
    let mut i = start;
    while i < chars.len() {
        match chars[i] {
            '\\' => i += 1,
            c if c == open => depth += 1,
            c if c == close => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn head(text: &str, n: usize) -> String {
    if text.chars().count() <= n {
        return text.to_string();
    }
    let cut: String = text.chars().take(n).collect();
    format!("{}…", cut.trim_end())
}

fn tail(text: &str, n: usize) -> String {
    let len = text.chars().count();
    if len <= n {
        return text.to_string();
    }
    let cut: String = text.chars().skip(len - n).collect();
    format!("…{}", cut.trim_start())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lower(q: &str) -> Vec<char> {
        q.chars().flat_map(char::to_lowercase).collect()
    }

    fn found(body: &str, q: &str) -> Option<(String, String, String)> {
        match_in(body, &lower(q)).map(|m| (m.before, m.matched, m.after))
    }

    fn visible(line: &str) -> String {
        visible_lines(line).join("\n")
    }

    #[test]
    fn finds_a_match_ignoring_case_with_context() {
        let m = match_in(
            "# Notes\n\nWe met with **Acme** on Tuesday.\nacme again",
            &lower("ACME"),
        )
        .unwrap();
        assert_eq!(
            (m.before.as_str(), m.matched.as_str(), m.after.as_str()),
            ("We met with ", "Acme", " on Tuesday.")
        );
        assert_eq!(m.count, 2);
    }

    #[test]
    fn shows_link_text_not_markdown() {
        let body = "And a [url](https://www.example.com)?";
        assert_eq!(
            found(body, "url"),
            Some(("And a ".into(), "url".into(), "?".into()))
        );
        // The address isn't shown, so it isn't searched either.
        assert_eq!(found(body, "example"), None);
    }

    #[test]
    fn markdown_becomes_the_text_the_editor_shows() {
        assert_eq!(visible("## A *b* **c** `d` ~~e~~"), "A b c d e");
        assert_eq!(visible("- [ ] Call ![logo](a.png) [Bob][bob]"), "Call logo Bob");
        assert_eq!(
            visible("1. First <br> <https://x.org> \\*literal\\*"),
            "First https://x.org *literal*"
        );
        assert_eq!(
            visible("keep snake_case and _drop_ these"),
            "keep snake_case and drop these"
        );
        assert_eq!(visible("<!-- sync-conflict:start -->"), "");
        assert_eq!(visible("| A | B |\n|---|---|\n| 1 | 2 |"), "A B\n1 2");
        assert_eq!(visible("[bob]: https://example.com"), "");
        assert_eq!(visible("---\ntitle: x\n---\nBody"), "Body");
        assert_eq!(visible("```rust\nlet x = [a](b);\n```"), "let x = [a](b);");
        assert_eq!(visible("Not a [link] here"), "Not a [link] here");
    }

    #[test]
    fn handles_text_whose_lowercase_is_longer() {
        // "İ" lowercases to two characters; byte ranges must still line up.
        let m = match_in("İstanbul and STRAßE", &lower("straße")).unwrap();
        assert_eq!(m.matched, "STRAßE");
        assert_eq!(m.before, "İstanbul and ");
    }

    #[test]
    fn shortens_long_context() {
        let line = format!("{} needle {}", "a".repeat(100), "b".repeat(100));
        let m = match_in(&line, &lower("needle")).unwrap();
        assert!(m.before.starts_with('…') && m.before.chars().count() <= CONTEXT + 1);
        assert!(m.after.ends_with('…') && m.after.chars().count() <= CONTEXT + 1);
    }

    #[test]
    fn no_match() {
        assert_eq!(match_in("nothing here", &lower("zebra")), None);
    }
}
