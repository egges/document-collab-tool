//! YAML front matter, as other Markdown tools write it (Obsidian, Jekyll,
//! Hugo, static site generators, some AI agents):
//!
//! ```text
//! ---
//! title: Trip notes
//! tags: [travel, 2026]
//! ---
//! The page itself.
//! ```
//!
//! Our pages keep this in `meta.json` instead: the title in `title`, the rest
//! in `properties`. The editor can't show front matter, so it is moved there
//! before a page reaches the editor ([`crate::Workspace::lift_front_matter`])
//! and when Markdown files are imported ([`crate::import`]).

use serde_json::{Map, Number, Value};
use yaml_rust2::{Yaml, YamlLoader};

/// Front matter split off a page and read as data.
#[derive(Debug, Clone, PartialEq)]
pub struct FrontMatter {
    /// The `title` field, if it held text (or a number).
    pub title: Option<String>,
    /// Every other field, converted to JSON.
    pub properties: Map<String, Value>,
    /// The page without its front matter.
    pub body: String,
}

/// The front matter block at the very top of `markdown`, if there is one:
/// `---` on the first line, a YAML mapping, and `---` on a line of its own.
/// `None` when there is none, or when what sits between the two rules isn't
/// a YAML mapping. That is ordinary Markdown (a rule, then a paragraph
/// underlined as a heading), so it stays in the page.
pub fn parse(markdown: &str) -> Option<FrontMatter> {
    let (yaml, body) = split(markdown)?;
    let mut properties = if yaml.trim().is_empty() {
        Map::new()
    } else {
        let mut docs = YamlLoader::load_from_str(yaml).ok()?;
        if docs.len() != 1 {
            return None;
        }
        match to_json(docs.pop()?) {
            Value::Object(map) => map,
            Value::Null => Map::new(),
            _ => return None,
        }
    };
    let title = match properties.get("title") {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    };
    if title.is_some() {
        properties.remove("title");
    }
    Some(FrontMatter {
        title,
        properties,
        body: body.trim_start_matches(['\n', '\r']).to_string(),
    })
}

/// The YAML between the opening and closing `---`, and the rest of the page.
fn split(markdown: &str) -> Option<(&str, &str)> {
    let text = markdown.strip_prefix('\u{feff}').unwrap_or(markdown);
    let rest = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))?;
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches(['\n', '\r']) == "---" {
            return Some((&rest[..offset], &rest[offset + line.len()..]));
        }
        offset += line.len();
    }
    None
}

fn to_json(yaml: Yaml) -> Value {
    match yaml {
        Yaml::Null | Yaml::BadValue | Yaml::Alias(_) => Value::Null,
        Yaml::Boolean(b) => Value::Bool(b),
        Yaml::Integer(i) => Value::Number(i.into()),
        Yaml::Real(text) => text
            .parse::<f64>()
            .ok()
            .and_then(Number::from_f64)
            .map(Value::Number)
            .unwrap_or(Value::String(text)),
        Yaml::String(s) => Value::String(s),
        Yaml::Array(items) => Value::Array(items.into_iter().map(to_json).collect()),
        Yaml::Hash(entries) => Value::Object(
            entries
                .into_iter()
                .filter_map(|(key, value)| Some((key_text(key)?, to_json(value))))
                .collect(),
        ),
    }
}

/// A mapping key as text; keys that are lists or mappings are dropped.
fn key_text(key: Yaml) -> Option<String> {
    match key {
        Yaml::String(s) | Yaml::Real(s) => Some(s),
        Yaml::Integer(i) => Some(i.to_string()),
        Yaml::Boolean(b) => Some(b.to_string()),
        Yaml::Null => Some("null".into()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_title_and_properties() {
        let fm = parse("---\ntitle: Trip notes\ntags: [travel, 2026]\ndraft: true\n---\n\nBody\n").unwrap();
        assert_eq!(fm.title.as_deref(), Some("Trip notes"));
        assert_eq!(
            Value::Object(fm.properties),
            json!({"tags": ["travel", 2026], "draft": true})
        );
        assert_eq!(fm.body, "Body\n");
    }

    #[test]
    fn keeps_dates_and_nested_values() {
        let fm = parse("---\ndate: 2026-11-25\nauthor:\n  name: Anna\nscore: 1.5\n---\n").unwrap();
        assert_eq!(fm.title, None);
        assert_eq!(
            Value::Object(fm.properties),
            json!({"date": "2026-11-25", "author": {"name": "Anna"}, "score": 1.5})
        );
        assert_eq!(fm.body, "");
    }

    #[test]
    fn handles_windows_line_endings_and_bom() {
        let fm = parse("\u{feff}---\r\ntitle: A\r\n---\r\nBody\r\n").unwrap();
        assert_eq!(fm.title.as_deref(), Some("A"));
        assert_eq!(fm.body, "Body\r\n");
    }

    #[test]
    fn empty_front_matter_is_removed() {
        let fm = parse("---\n\n---\nBody\n").unwrap();
        assert!(fm.properties.is_empty());
        assert_eq!(fm.body, "Body\n");
    }

    #[test]
    fn leaves_ordinary_markdown_alone() {
        // A rule, then a paragraph underlined as a heading.
        assert_eq!(parse("---\nJust a heading\n---\nText\n"), None);
        assert_eq!(parse("Text\n---\na: 1\n---\n"), None);
        assert_eq!(parse("---\na: 1\nno closing rule\n"), None);
        assert_eq!(parse("---\n- a list\n---\n"), None);
        assert_eq!(parse("---\na: [unclosed\n---\n"), None);
    }

    #[test]
    fn a_title_that_is_not_text_stays_a_property() {
        let fm = parse("---\ntitle: [a, b]\n---\n").unwrap();
        assert_eq!(fm.title, None);
        assert_eq!(Value::Object(fm.properties), json!({"title": ["a", "b"]}));
        assert_eq!(
            parse("---\ntitle: 2026\n---\n").unwrap().title.as_deref(),
            Some("2026")
        );
    }
}
