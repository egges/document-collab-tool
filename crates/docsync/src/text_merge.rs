//! Conflict blocks for Markdown pages.
//!
//! When two devices edit the same lines, both versions are kept in the page
//! inside a block the editor can render and let the user resolve:
//!
//! ```markdown
//! <!-- sync-conflict:start -->
//! <!-- sync-conflict:version Laptop -->
//! The laptop's version of the paragraph.
//! <!-- sync-conflict:version Desktop -->
//! The desktop's version of the paragraph.
//! <!-- sync-conflict:end -->
//! ```
//!
//! The markers are HTML comments, so the file stays valid Markdown and
//! renders sensibly in any other Markdown viewer.

/// Git's conflict marker length used internally. Much longer than the
/// default of 7, so ordinary content is never mistaken for a marker.
pub const MARKER_SIZE: usize = 32;

pub const BLOCK_START: &str = "<!-- sync-conflict:start -->";
pub const BLOCK_END: &str = "<!-- sync-conflict:end -->";
pub const VERSION_PREFIX: &str = "<!-- sync-conflict:version ";

pub fn version_marker(label: &str) -> String {
    // Keep the label from closing the comment early.
    let label: String = label
        .replace("--", "-")
        .chars()
        .filter(|c| !c.is_control() && *c != '>')
        .collect();
    format!("{VERSION_PREFIX}{} -->", label.trim())
}

/// Turn git conflict markers (of [`MARKER_SIZE`]) into conflict blocks.
pub fn rewrite_conflicts(merged: &[u8], local_label: &str, remote_label: &str) -> Vec<u8> {
    enum State {
        Normal,
        Ours(Vec<u8>),
        Theirs(Vec<u8>, Vec<u8>),
    }

    let mut out = Vec::with_capacity(merged.len() + 256);
    let mut state = State::Normal;

    for line in merged.split_inclusive(|b| *b == b'\n') {
        state = match state {
            State::Normal if is_marker(line, b'<') => State::Ours(Vec::new()),
            State::Normal => {
                out.extend_from_slice(line);
                State::Normal
            }
            State::Ours(ours) if is_marker(line, b'=') => State::Theirs(ours, Vec::new()),
            State::Ours(mut ours) => {
                ours.extend_from_slice(line);
                State::Ours(ours)
            }
            State::Theirs(ours, theirs) if is_marker(line, b'>') => {
                push_line(&mut out, BLOCK_START.as_bytes());
                push_line(&mut out, version_marker(local_label).as_bytes());
                push_section(&mut out, &ours);
                push_line(&mut out, version_marker(remote_label).as_bytes());
                push_section(&mut out, &theirs);
                push_line(&mut out, BLOCK_END.as_bytes());
                State::Normal
            }
            State::Theirs(ours, mut theirs) => {
                theirs.extend_from_slice(line);
                State::Theirs(ours, theirs)
            }
        };
    }

    // An unterminated block should never happen; keep its content regardless.
    match state {
        State::Normal => {}
        State::Ours(ours) => out.extend_from_slice(&ours),
        State::Theirs(ours, theirs) => {
            push_section(&mut out, &ours);
            out.extend_from_slice(&theirs);
        }
    }
    out
}

fn is_marker(line: &[u8], ch: u8) -> bool {
    line.len() >= MARKER_SIZE
        && line[..MARKER_SIZE].iter().all(|b| *b == ch)
        && matches!(line.get(MARKER_SIZE), None | Some(b' ' | b'\n' | b'\r'))
}

fn push_line(out: &mut Vec<u8>, line: &[u8]) {
    out.extend_from_slice(line);
    out.push(b'\n');
}

fn push_section(out: &mut Vec<u8>, section: &[u8]) {
    out.extend_from_slice(section);
    if !section.is_empty() && !section.ends_with(b"\n") {
        out.push(b'\n');
    }
}

/// Whether text contains raw git conflict markers (of any length >= 7).
/// Used by tests and integrity checks: these must never reach a user.
pub fn has_git_conflict_markers(text: &str) -> bool {
    text.lines().any(|line| {
        ["<<<<<<<", "=======", ">>>>>>>"].iter().any(|m| {
            line.starts_with(m) && {
                let ch = m.as_bytes()[0];
                let run = line.bytes().take_while(|b| *b == ch).count();
                matches!(line.as_bytes().get(run), None | Some(b' '))
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn markers(c: char) -> String {
        c.to_string().repeat(MARKER_SIZE)
    }

    #[test]
    fn rewrites_a_conflict_into_a_block() {
        let merged = format!(
            "intro\n{} me\nmine\n{}\ntheirs\n{} them\noutro\n",
            markers('<'),
            markers('='),
            markers('>')
        );
        let out = String::from_utf8(rewrite_conflicts(merged.as_bytes(), "Laptop", "Desktop")).unwrap();
        assert_eq!(
            out,
            "intro\n\
             <!-- sync-conflict:start -->\n\
             <!-- sync-conflict:version Laptop -->\n\
             mine\n\
             <!-- sync-conflict:version Desktop -->\n\
             theirs\n\
             <!-- sync-conflict:end -->\n\
             outro\n"
        );
        assert!(!has_git_conflict_markers(&out));
    }

    #[test]
    fn leaves_short_marker_lookalikes_alone() {
        let text = "<<<<<<< not ours\n=======\n";
        assert_eq!(rewrite_conflicts(text.as_bytes(), "a", "b"), text.as_bytes());
        assert!(has_git_conflict_markers(text));
        assert!(!has_git_conflict_markers("a ==== b\n<<<x\n"));
    }

    #[test]
    fn labels_cannot_break_out_of_the_comment() {
        assert_eq!(
            version_marker("evil --> <b>"),
            "<!-- sync-conflict:version evil - <b -->"
        );
    }
}
