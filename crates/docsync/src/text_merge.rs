//! Conflict blocks for Markdown pages.
//!
//! When two devices edit the same lines, both versions are kept in the page
//! inside a block the editor can render and let the user resolve:
//!
//! ```markdown
//! <!-- sync-conflict:start -->
//! <!-- sync-conflict:version person="Anna Smith" person-id="github:1234" device="Laptop" device-id="3f9a1c2b" -->
//! Anna's version of the paragraph, written on her laptop.
//! <!-- sync-conflict:version device="Desktop" -->
//! The version from a desktop nobody was signed in on.
//! <!-- sync-conflict:end -->
//! ```
//!
//! Each version says who wrote it ([`VersionLabel`]): the person, when the
//! device was signed in, and the device, each by name and, where known, by
//! an id that tells two people (or devices) with the same name apart. A version marker may also hold
//! plain text instead, such as "Changed elsewhere", or a device name in a
//! block written before versions named people.
//!
//! The markers are HTML comments, so the file stays valid Markdown and
//! renders sensibly in any other Markdown viewer.

use std::fmt;

/// Git's conflict marker length used internally. Much longer than the
/// default of 7, so ordinary content is never mistaken for a marker.
pub const MARKER_SIZE: usize = 32;

pub const BLOCK_START: &str = "<!-- sync-conflict:start -->";
pub const BLOCK_END: &str = "<!-- sync-conflict:end -->";
pub const VERSION_PREFIX: &str = "<!-- sync-conflict:version ";

/// Who wrote something: the person, when the device was signed in, and the
/// device they wrote it on.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Writer {
    pub person: Option<String>,
    /// Never changes, unlike the name: see [`crate::Person::id`].
    pub person_id: Option<String>,
    pub device: Option<String>,
    /// Never changes, unlike the name: see [`crate::SyncConfig::device_id`].
    pub device_id: Option<String>,
}

/// What a version in a conflict block is labelled with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VersionLabel {
    /// Who wrote the version.
    By(Writer),
    /// Anything else: "Changed elsewhere", or the label of a block written
    /// before versions named people (usually a device name).
    Text(String),
}

impl VersionLabel {
    pub fn person(&self) -> Option<&str> {
        match self {
            VersionLabel::By(writer) => writer.person.as_deref(),
            VersionLabel::Text(_) => None,
        }
    }

    pub fn device(&self) -> Option<&str> {
        match self {
            VersionLabel::By(writer) => writer.device.as_deref(),
            VersionLabel::Text(_) => None,
        }
    }
}

/// "Anna Smith (Laptop)", "Anna Smith", "Laptop", or the plain text.
impl fmt::Display for VersionLabel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VersionLabel::Text(text) => f.write_str(text),
            VersionLabel::By(writer) => match (&writer.person, &writer.device) {
                (Some(person), Some(device)) => write!(f, "{person} ({device})"),
                (Some(name), None) | (None, Some(name)) => f.write_str(name),
                (None, None) => Ok(()),
            },
        }
    }
}

pub fn version_marker(label: &VersionLabel) -> String {
    // Keep the label from closing the comment early.
    let clean = |text: &str| -> String {
        text.replace("--", "-")
            .chars()
            .filter(|c| !c.is_control() && *c != '>')
            .collect()
    };
    let label = match label {
        VersionLabel::Text(text) => clean(text),
        VersionLabel::By(writer) => [
            ("person", &writer.person),
            ("person-id", &writer.person_id),
            ("device", &writer.device),
            ("device-id", &writer.device_id),
        ]
        .into_iter()
        .filter_map(|(key, value)| {
            let value = clean(value.as_deref()?).replace('"', "'");
            Some(format!("{key}=\"{}\"", value.trim()))
        })
        .collect::<Vec<_>>()
        .join(" "),
    };
    format!("{VERSION_PREFIX}{} -->", label.trim())
}

/// The label in a version marker, given the text between
/// [`VERSION_PREFIX`] and the closing `-->`.
pub fn parse_version_label(text: &str) -> VersionLabel {
    let text = text.trim();
    match parse_writer(text) {
        Some(writer) => VersionLabel::By(writer),
        None => VersionLabel::Text(text.to_string()),
    }
}

/// `person="..." device="..."`, either or both, each optionally with its
/// `-id`. Other `key="value"` pairs are skipped, so a later version can add
/// some.
fn parse_writer(mut rest: &str) -> Option<Writer> {
    let mut writer = Writer::default();
    while !rest.is_empty() {
        let (key, after) = rest.split_once("=\"")?;
        let (value, after) = after.split_once('"')?;
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_lowercase() || c == '-') {
            return None;
        }
        match key {
            "person" => writer.person = Some(value.to_string()),
            "person-id" => writer.person_id = Some(value.to_string()),
            "device" => writer.device = Some(value.to_string()),
            "device-id" => writer.device_id = Some(value.to_string()),
            _ => {}
        }
        rest = after.trim_start();
    }
    (writer.person.is_some() || writer.device.is_some()).then_some(writer)
}

/// Turn git conflict markers (of [`MARKER_SIZE`]) into conflict blocks.
pub fn rewrite_conflicts(merged: &[u8], local_label: &VersionLabel, remote_label: &VersionLabel) -> Vec<u8> {
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

    fn by(person: Option<&str>, device: Option<&str>) -> VersionLabel {
        VersionLabel::By(Writer {
            person: person.map(String::from),
            device: device.map(String::from),
            ..Writer::default()
        })
    }

    /// What's between the prefix and the `-->` of a version marker.
    fn inside(marker: &str) -> &str {
        marker
            .strip_prefix(VERSION_PREFIX)
            .and_then(|rest| rest.strip_suffix("-->"))
            .expect("a version marker")
    }

    #[test]
    fn rewrites_a_conflict_into_a_block() {
        let merged = format!(
            "intro\n{} me\nmine\n{}\ntheirs\n{} them\noutro\n",
            markers('<'),
            markers('='),
            markers('>')
        );
        let out = String::from_utf8(rewrite_conflicts(
            merged.as_bytes(),
            &by(Some("Anna Smith"), Some("Laptop")),
            &by(None, Some("Desktop")),
        ))
        .unwrap();
        assert_eq!(
            out,
            "intro\n\
             <!-- sync-conflict:start -->\n\
             <!-- sync-conflict:version person=\"Anna Smith\" device=\"Laptop\" -->\n\
             mine\n\
             <!-- sync-conflict:version device=\"Desktop\" -->\n\
             theirs\n\
             <!-- sync-conflict:end -->\n\
             outro\n"
        );
        assert!(!has_git_conflict_markers(&out));
    }

    #[test]
    fn leaves_short_marker_lookalikes_alone() {
        let text = "<<<<<<< not ours\n=======\n";
        let (a, b) = (VersionLabel::Text("a".into()), VersionLabel::Text("b".into()));
        assert_eq!(rewrite_conflicts(text.as_bytes(), &a, &b), text.as_bytes());
        assert!(has_git_conflict_markers(text));
        assert!(!has_git_conflict_markers("a ==== b\n<<<x\n"));
    }

    #[test]
    fn labels_cannot_break_out_of_the_comment() {
        assert_eq!(
            version_marker(&VersionLabel::Text("evil --> <b>".into())),
            "<!-- sync-conflict:version evil - <b -->"
        );
        // Nor out of the quotes around a name.
        let marker = version_marker(&by(Some("Dwayne \"The Rock\" --> J"), Some("Mac")));
        assert_eq!(
            marker,
            "<!-- sync-conflict:version person=\"Dwayne 'The Rock' - J\" device=\"Mac\" -->"
        );
        assert_eq!(
            parse_version_label(inside(&marker)),
            by(Some("Dwayne 'The Rock' - J"), Some("Mac"))
        );
    }

    #[test]
    fn a_label_names_the_person_and_the_device() {
        for label in [
            by(Some("Anna Smith"), Some("Anna's MacBook Pro (2)")),
            by(Some("Sam (they/them)"), None),
            by(None, Some("Laptop")),
            VersionLabel::Text("Changed elsewhere".into()),
            // From before versions named people.
            VersionLabel::Text("Arjans-MacBook-Pro".into()),
        ] {
            assert_eq!(parse_version_label(inside(&version_marker(&label))), label);
        }
        assert_eq!(by(Some("Anna"), Some("Laptop")).to_string(), "Anna (Laptop)");
        assert_eq!(by(None, Some("Laptop")).to_string(), "Laptop");
        assert_eq!(by(Some("Anna"), None).to_string(), "Anna");
    }

    #[test]
    fn a_label_carries_the_ids_of_the_person_and_the_device() {
        let label = VersionLabel::By(Writer {
            person: Some("Anna Smith".into()),
            person_id: Some("5e6d7f803f9a1c2b".into()),
            device: Some("MacBook-Pro".into()),
            device_id: Some("3f9a1c2b".into()),
        });
        let marker = version_marker(&label);
        assert_eq!(
            marker,
            "<!-- sync-conflict:version person=\"Anna Smith\" person-id=\"5e6d7f803f9a1c2b\" \
             device=\"MacBook-Pro\" device-id=\"3f9a1c2b\" -->"
        );
        assert_eq!(parse_version_label(inside(&marker)), label);
        // The ids aren't shown.
        assert_eq!(label.to_string(), "Anna Smith (MacBook-Pro)");
    }

    #[test]
    fn a_label_that_only_looks_like_names_is_plain_text() {
        for text in [
            "person=Anna",
            "person=\"Anna",
            "Person=\"Anna\"",
            "by person=\"Anna\"",
            "agent=\"Claude\"",
        ] {
            assert_eq!(
                parse_version_label(text),
                VersionLabel::Text(text.into()),
                "{text}"
            );
        }
        // Pairs this version doesn't know are skipped.
        assert_eq!(
            parse_version_label("person=\"Anna\" agent=\"Claude\" device=\"Mac\""),
            by(Some("Anna"), Some("Mac"))
        );
    }
}
