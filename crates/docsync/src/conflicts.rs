//! Finding and resolving the conflict blocks sync leaves in a page.
//!
//! The editor and AI agents resolve conflicts through these functions, so a
//! resolution means the same thing whoever makes it. See
//! [`crate::text_merge`] for the block format.
//!
//! A block may have blank lines between its markers: the editor writes each
//! marker as its own paragraph. Those blank lines are not part of a version.
//! A block may also contain another block, when a page conflicts again
//! before anyone resolved the first conflict. The inner block then belongs to
//! the version it appears in.
//!
//! Only well-formed blocks are found: a start marker, at least one version
//! marker before any other text, and an end marker. Anything else is left
//! alone, because resolving a block we don't understand could lose text.

use crate::text_merge::{BLOCK_END, BLOCK_START, VERSION_PREFIX};

/// A conflict block in a page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictBlock {
    /// Byte range of the whole block in the page, from the start of its start
    /// marker line to the end of its end marker line.
    pub range: std::ops::Range<usize>,
    pub versions: Vec<ConflictVersion>,
}

/// One version inside a conflict block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictVersion {
    /// Usually the name of the device that wrote it.
    pub label: String,
    /// The version's Markdown without the blank lines around it. Ends with a
    /// newline unless it's empty (one side deleted the lines).
    pub text: String,
}

enum Marker<'a> {
    Start,
    Version(&'a str),
    End,
}

fn marker(line: &str) -> Option<Marker<'_>> {
    let line = line.trim_end();
    if line == BLOCK_START {
        Some(Marker::Start)
    } else if line == BLOCK_END {
        Some(Marker::End)
    } else {
        line.strip_prefix(VERSION_PREFIX)
            .and_then(|rest| rest.strip_suffix("-->"))
            .map(|label| Marker::Version(label.trim()))
    }
}

fn is_blank(line: &str) -> bool {
    line.trim().is_empty()
}

/// The well-formed conflict blocks in `page`, in order. Blocks nested inside
/// another block's version are not listed separately.
pub fn find_conflicts(page: &str) -> Vec<ConflictBlock> {
    struct Open {
        start: usize,
        versions: Vec<(String, Vec<String>)>,
        /// How many nested blocks we're inside, within the current version.
        depth: usize,
        malformed: bool,
    }

    let mut blocks = Vec::new();
    let mut open: Option<Open> = None;
    let mut offset = 0;

    for line in page.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();
        let Some(block) = open.as_mut() else {
            if let Some(Marker::Start) = marker(line) {
                open = Some(Open {
                    start: line_start,
                    versions: Vec::new(),
                    depth: 0,
                    malformed: false,
                });
            }
            continue;
        };

        match (marker(line), block.depth) {
            (Some(Marker::End), 0) => {
                let block = open.take().expect("open");
                if !block.malformed && !block.versions.is_empty() {
                    blocks.push(ConflictBlock {
                        range: block.start..offset,
                        versions: block
                            .versions
                            .into_iter()
                            .map(|(label, lines)| ConflictVersion {
                                label,
                                text: trim_blank_lines(&lines),
                            })
                            .collect(),
                    });
                }
            }
            (Some(Marker::Version(label)), 0) => block.versions.push((label.to_string(), Vec::new())),
            (marker, depth) => {
                match marker {
                    Some(Marker::Start) => block.depth += 1,
                    Some(Marker::End) => block.depth = depth - 1,
                    _ => {}
                }
                match block.versions.last_mut() {
                    Some((_, lines)) => lines.push(line.to_string()),
                    // Text between the start marker and the first version.
                    None if !is_blank(line) => block.malformed = true,
                    None => {}
                }
            }
        }
    }
    blocks
}

fn trim_blank_lines(lines: &[String]) -> String {
    let first = lines.iter().position(|l| !is_blank(l));
    let last = lines.iter().rposition(|l| !is_blank(l));
    let (Some(first), Some(last)) = (first, last) else {
        return String::new();
    };
    let mut text: String = lines[first..=last].concat();
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text
}

/// Why [`resolve_conflict`] could not resolve a block.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ResolveError {
    #[error("the page has {count} conflict blocks, so there is no block {index}")]
    NoSuchBlock { index: usize, count: usize },
    #[error("conflict block {index} has {count} versions, so there is no version {version}")]
    NoSuchVersion {
        index: usize,
        version: usize,
        count: usize,
    },
}

/// Replace conflict block `index` (as numbered by [`find_conflicts`]) with
/// version `keep` of it, and return the new page.
pub fn resolve_conflict(page: &str, index: usize, keep: usize) -> Result<String, ResolveError> {
    let blocks = find_conflicts(page);
    let count = blocks.len();
    let block = blocks
        .into_iter()
        .nth(index)
        .ok_or(ResolveError::NoSuchBlock { index, count })?;
    let version_count = block.versions.len();
    let version = block
        .versions
        .into_iter()
        .nth(keep)
        .ok_or(ResolveError::NoSuchVersion {
            index,
            version: keep,
            count: version_count,
        })?;

    let before = &page[..block.range.start];
    let mut after = &page[block.range.end..];
    let mut text = version.text;
    if !page[..block.range.end].ends_with('\n') {
        // The end marker was the last line and had no newline; keep it that way.
        if text.ends_with('\n') {
            text.pop();
            if text.ends_with('\r') {
                text.pop();
            }
        }
    }
    // Keeping an empty version leaves the blank lines from both sides of the
    // block next to each other. Drop one set.
    if text.is_empty() && (before.is_empty() || before.ends_with("\n\n")) {
        let blank = after
            .split_inclusive('\n')
            .take_while(|l| is_blank(l))
            .map(str::len)
            .sum();
        after = &after[blank..];
    }
    Ok(format!("{before}{text}{after}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const RAW: &str = "intro\n\
        <!-- sync-conflict:start -->\n\
        <!-- sync-conflict:version Laptop -->\n\
        mine\n\
        <!-- sync-conflict:version Desktop -->\n\
        theirs\n\
        second line\n\
        <!-- sync-conflict:end -->\n\
        outro\n";

    // RAW after the editor saved it: every marker is its own paragraph.
    const FROM_EDITOR: &str = "intro\n\n\
        <!-- sync-conflict:start -->\n\n\
        <!-- sync-conflict:version Laptop -->\n\n\
        mine\n\n\
        <!-- sync-conflict:version Desktop -->\n\n\
        theirs\n\
        second line\n\n\
        <!-- sync-conflict:end -->\n\n\
        outro\n";

    fn versions(page: &str) -> Vec<Vec<(String, String)>> {
        find_conflicts(page)
            .into_iter()
            .map(|b| b.versions.into_iter().map(|v| (v.label, v.text)).collect())
            .collect()
    }

    fn v(label: &str, text: &str) -> (String, String) {
        (label.to_string(), text.to_string())
    }

    #[test]
    fn finds_a_block_and_its_versions() {
        let blocks = find_conflicts(RAW);
        assert_eq!(blocks.len(), 1);
        assert_eq!(&RAW[blocks[0].range.clone()], &RAW[6..RAW.len() - 6]);
        assert_eq!(
            versions(RAW),
            [vec![v("Laptop", "mine\n"), v("Desktop", "theirs\nsecond line\n")]]
        );
    }

    #[test]
    fn ignores_blank_lines_the_editor_adds() {
        assert_eq!(versions(FROM_EDITOR), versions(RAW));
    }

    #[test]
    fn keeping_a_version_replaces_the_block() {
        assert_eq!(resolve_conflict(RAW, 0, 0).unwrap(), "intro\nmine\noutro\n");
        assert_eq!(
            resolve_conflict(RAW, 0, 1).unwrap(),
            "intro\ntheirs\nsecond line\noutro\n"
        );
        assert_eq!(
            resolve_conflict(FROM_EDITOR, 0, 0).unwrap(),
            "intro\n\nmine\n\noutro\n"
        );
    }

    #[test]
    fn keeping_an_empty_version_does_not_leave_a_double_gap() {
        let page = "intro\n\n\
            <!-- sync-conflict:start -->\n\n\
            <!-- sync-conflict:version Laptop -->\n\n\
            <!-- sync-conflict:version Desktop -->\n\n\
            theirs\n\n\
            <!-- sync-conflict:end -->\n\n\
            outro\n";
        assert_eq!(versions(page), [vec![v("Laptop", ""), v("Desktop", "theirs\n")]]);
        assert_eq!(resolve_conflict(page, 0, 0).unwrap(), "intro\n\noutro\n");
        let raw = "intro\n<!-- sync-conflict:start -->\n<!-- sync-conflict:version A -->\n\
            <!-- sync-conflict:version B -->\nb\n<!-- sync-conflict:end -->\noutro\n";
        assert_eq!(resolve_conflict(raw, 0, 0).unwrap(), "intro\noutro\n");
    }

    #[test]
    fn resolves_the_block_it_was_asked_to() {
        let page = format!("{RAW}{}", RAW.replace("mine", "mine 2"));
        assert_eq!(find_conflicts(&page).len(), 2);
        let once = resolve_conflict(&page, 1, 0).unwrap();
        assert_eq!(once, format!("{RAW}intro\nmine 2\noutro\n"));
        assert_eq!(
            resolve_conflict(&once, 0, 1).unwrap().matches("theirs").count(),
            1
        );
    }

    #[test]
    fn a_nested_block_belongs_to_its_version() {
        let inner = "<!-- sync-conflict:start -->\n<!-- sync-conflict:version A -->\na\n\
            <!-- sync-conflict:version B -->\nb\n<!-- sync-conflict:end -->\n";
        let page = format!(
            "<!-- sync-conflict:start -->\n<!-- sync-conflict:version Laptop -->\n{inner}\
             <!-- sync-conflict:version Desktop -->\nnew\n<!-- sync-conflict:end -->\n"
        );
        assert_eq!(versions(&page), [vec![v("Laptop", inner), v("Desktop", "new\n")]]);
        let kept = resolve_conflict(&page, 0, 0).unwrap();
        assert_eq!(kept, inner);
        assert_eq!(resolve_conflict(&kept, 0, 1).unwrap(), "b\n");
    }

    #[test]
    fn leaves_malformed_blocks_alone() {
        let unterminated = "<!-- sync-conflict:start -->\n<!-- sync-conflict:version A -->\na\n";
        let text_before_version = "<!-- sync-conflict:start -->\nstray\n<!-- sync-conflict:version A -->\n\
            a\n<!-- sync-conflict:end -->\n";
        let no_versions = "<!-- sync-conflict:start -->\n<!-- sync-conflict:end -->\n";
        for page in [unterminated, text_before_version, no_versions, "plain\n"] {
            assert!(find_conflicts(page).is_empty(), "{page}");
            assert_eq!(
                resolve_conflict(page, 0, 0),
                Err(ResolveError::NoSuchBlock { index: 0, count: 0 })
            );
        }
    }

    #[test]
    fn rejects_a_version_that_does_not_exist() {
        assert_eq!(
            resolve_conflict(RAW, 0, 2),
            Err(ResolveError::NoSuchVersion {
                index: 0,
                version: 2,
                count: 2
            })
        );
    }

    #[test]
    fn handles_windows_line_endings_and_a_missing_final_newline() {
        let crlf = RAW.replace('\n', "\r\n");
        assert_eq!(versions(&crlf)[0][0], v("Laptop", "mine\r\n"));
        assert_eq!(
            resolve_conflict(&crlf, 0, 0).unwrap(),
            "intro\r\nmine\r\noutro\r\n"
        );
        let at_end = RAW.trim_end_matches("outro\n").trim_end_matches('\n');
        assert_eq!(resolve_conflict(at_end, 0, 0).unwrap(), "intro\nmine");
    }

    #[test]
    fn round_trips_blocks_written_by_the_merge() {
        let m = |c: char| c.to_string().repeat(crate::text_merge::MARKER_SIZE);
        let merged = format!("a\n{} x\nours\n{}\ntheirs\n{} y\nb\n", m('<'), m('='), m('>'));
        let page = String::from_utf8(crate::text_merge::rewrite_conflicts(
            merged.as_bytes(),
            "Mac",
            "PC",
        ))
        .unwrap();
        assert_eq!(versions(&page), [vec![v("Mac", "ours\n"), v("PC", "theirs\n")]]);
        assert_eq!(resolve_conflict(&page, 0, 1).unwrap(), "a\ntheirs\nb\n");
    }
}
