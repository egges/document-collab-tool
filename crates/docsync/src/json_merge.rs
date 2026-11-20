//! Field-level three-way merge for JSON files, plus canonical formatting.
//!
//! Workspace JSON is always written with sorted keys and one field per line,
//! so git's own line merge already succeeds when two devices change different
//! fields. This module handles the cases git cannot: both sides changed the
//! same field, or the formatting got out of step.

use serde_json::{Map, Value};

use crate::Result;

/// Which version of a conflicting value to keep.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Ours,
    Theirs,
}

/// Canonical serialization: sorted keys, two-space indent, trailing newline.
pub fn to_canonical_bytes(value: &Value) -> Vec<u8> {
    let mut out = serde_json::to_vec_pretty(&canonicalize(value)).expect("JSON values serialize");
    out.push(b'\n');
    out
}

/// A copy of `value` with every object's keys in sorted order.
pub fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut sorted = Map::new();
            for key in keys {
                sorted.insert(key.clone(), canonicalize(&map[key]));
            }
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        other => other.clone(),
    }
}

/// The value at a key path inside nested objects.
pub fn value_at<'a>(value: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter().try_fold(value, |v, key| v.as_object()?.get(key))
}

/// Merge `ours` and `theirs` against their common ancestor `base`.
///
/// Objects merge key by key, recursively. A key changed on only one side
/// takes that change. A key removed on one side and changed on the other
/// keeps the change. When both sides changed a key to different values,
/// `pick` chooses (by recency). Arrays and scalars are atomic.
///
/// Returns the merged value and the dotted key paths that needed `pick`.
pub fn merge(
    base: Option<&Value>,
    ours: &Value,
    theirs: &Value,
    pick: &mut dyn FnMut(&[String]) -> Result<Side>,
) -> Result<(Value, Vec<String>)> {
    let mut conflicts = Vec::new();
    let mut path = Vec::new();
    let merged = merge_value(&mut path, base, Some(ours), Some(theirs), pick, &mut conflicts)?;
    Ok((merged.unwrap_or(Value::Null), conflicts))
}

fn merge_value(
    path: &mut Vec<String>,
    base: Option<&Value>,
    ours: Option<&Value>,
    theirs: Option<&Value>,
    pick: &mut dyn FnMut(&[String]) -> Result<Side>,
    conflicts: &mut Vec<String>,
) -> Result<Option<Value>> {
    if ours == theirs || theirs == base {
        return Ok(ours.cloned());
    }
    if ours == base {
        return Ok(theirs.cloned());
    }
    match (ours, theirs) {
        (Some(Value::Object(o)), Some(Value::Object(t))) => {
            let b = base.and_then(Value::as_object);
            let mut keys: Vec<&String> = o
                .keys()
                .chain(t.keys())
                .chain(b.into_iter().flat_map(|b| b.keys()))
                .collect();
            keys.sort();
            keys.dedup();
            let mut merged = Map::new();
            for key in keys {
                path.push(key.clone());
                let value = merge_value(
                    path,
                    b.and_then(|b| b.get(key)),
                    o.get(key),
                    t.get(key),
                    pick,
                    conflicts,
                )?;
                path.pop();
                if let Some(value) = value {
                    merged.insert(key.clone(), value);
                }
            }
            Ok(Some(Value::Object(merged)))
        }
        // An edit beats a concurrent removal.
        (None, Some(kept)) | (Some(kept), None) => Ok(Some(kept.clone())),
        (Some(o), Some(t)) => {
            conflicts.push(path.join("."));
            Ok(Some(match pick(path)? {
                Side::Ours => o.clone(),
                Side::Theirs => t.clone(),
            }))
        }
        (None, None) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn merge_with(base: Value, ours: Value, theirs: Value, side: Side) -> (Value, Vec<String>) {
        merge(Some(&base), &ours, &theirs, &mut |_| Ok(side)).unwrap()
    }

    #[test]
    fn merges_different_keys() {
        let (v, c) = merge_with(
            json!({"a": 1, "b": 1}),
            json!({"a": 2, "b": 1}),
            json!({"a": 1, "b": 3}),
            Side::Theirs,
        );
        assert_eq!(v, json!({"a": 2, "b": 3}));
        assert!(c.is_empty());
    }

    #[test]
    fn recurses_into_objects() {
        let (v, c) = merge_with(
            json!({"p": {"x": 1, "y": 1}}),
            json!({"p": {"x": 2, "y": 1}}),
            json!({"p": {"x": 1, "y": 2, "z": 9}}),
            Side::Ours,
        );
        assert_eq!(v, json!({"p": {"x": 2, "y": 2, "z": 9}}));
        assert!(c.is_empty());
    }

    #[test]
    fn picks_a_side_for_the_same_key() {
        let base = json!({"p": {"status": "todo"}});
        let ours = json!({"p": {"status": "doing"}});
        let theirs = json!({"p": {"status": "done"}});
        let (v, c) = merge_with(base.clone(), ours.clone(), theirs.clone(), Side::Theirs);
        assert_eq!(v, json!({"p": {"status": "done"}}));
        assert_eq!(c, vec!["p.status".to_string()]);
        let (v, _) = merge_with(base, ours, theirs, Side::Ours);
        assert_eq!(v, json!({"p": {"status": "doing"}}));
    }

    #[test]
    fn edit_beats_removal() {
        let (v, _) = merge_with(
            json!({"a": 1, "b": 1}),
            json!({"b": 1}),
            json!({"a": 5, "b": 1}),
            Side::Ours,
        );
        assert_eq!(v, json!({"a": 5, "b": 1}));
    }

    #[test]
    fn removal_applies_when_other_side_unchanged() {
        let (v, _) = merge_with(
            json!({"a": 1, "b": 1}),
            json!({"b": 1}),
            json!({"a": 1, "b": 2}),
            Side::Ours,
        );
        assert_eq!(v, json!({"b": 2}));
    }

    #[test]
    fn canonical_form_sorts_keys() {
        let text = String::from_utf8(to_canonical_bytes(&json!({"b": 1, "a": {"d": 1, "c": 2}}))).unwrap();
        assert_eq!(
            text,
            "{\n  \"a\": {\n    \"c\": 2,\n    \"d\": 1\n  },\n  \"b\": 1\n}\n"
        );
    }
}
