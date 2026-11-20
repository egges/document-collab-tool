//! Merging two commits into a tree with every conflict resolved.
//!
//! Git's merge machinery does the heavy lifting (`merge-tree`, entirely in the
//! object database). Whatever it cannot merge is resolved here, by file type:
//!
//! | Situation                              | Resolution                                  |
//! |----------------------------------------|---------------------------------------------|
//! | Same lines of a page edited            | Both versions kept in a conflict block      |
//! | Same JSON field edited                 | Most recent edit wins (tie: remote wins)    |
//! | Same opaque file edited                | Most recent wins, other kept as a copy      |
//! | File edited on one side, deleted on other | The edit wins                            |
//! | Page/database deleted, edited elsewhere | The whole entity is restored               |
//!
//! Nothing here touches the working tree, so a crash at any point leaves the
//! repository exactly as it was.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::Path;

use serde_json::Value;

use crate::git::{BlobRef, ConflictEntry, GitBackend, Oid, TreeEdit};
use crate::json_merge::{self, Side};
use crate::layout::{self, FileKind};
use crate::{Result, text_merge};

/// How a conflict was resolved automatically.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    /// Overlapping text edits; both versions are in a conflict block.
    KeptBothVersions,
    /// Both sides changed the same JSON fields; the most recent edit won.
    NewestFieldsWon { fields: Vec<String> },
    /// The file was edited on one side and deleted on the other.
    KeptEditOverDelete,
    /// A page or database was deleted on one side and edited on the other.
    RestoredDeleted,
    /// An opaque file was changed on both sides. The newest version kept the
    /// original path, the other was saved at `copy`.
    KeptNewestWithCopy { copy: String },
}

impl fmt::Display for Resolution {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Resolution::KeptBothVersions => write!(f, "kept both versions of overlapping edits"),
            Resolution::NewestFieldsWon { fields } => {
                write!(f, "kept the newest value of {}", fields.join(", "))
            }
            Resolution::KeptEditOverDelete => write!(f, "kept the edit over the deletion"),
            Resolution::RestoredDeleted => write!(f, "restored because it was edited elsewhere"),
            Resolution::KeptNewestWithCopy { copy } => {
                write!(f, "kept the newest version, other version saved as {copy}")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedConflict {
    pub path: String,
    pub resolution: Resolution,
}

pub(crate) struct MergeOutcome {
    pub tree: Oid,
    pub conflicts: Vec<ResolvedConflict>,
}

type Probe<'p> = &'p dyn Fn(Option<&Oid>) -> Result<Option<String>>;

pub(crate) fn merge_commits(
    git: &dyn GitBackend,
    repo: &Path,
    ours: &Oid,
    theirs: &Oid,
    local_label: &str,
) -> Result<MergeOutcome> {
    let base = git.merge_base(repo, ours, theirs)?;
    let merged = git.merge_trees(repo, ours, theirs)?;
    let mut merger = Merger {
        git,
        repo,
        ours,
        theirs,
        base,
        local_label,
        edits: BTreeMap::new(),
        conflicts: Vec::new(),
    };
    for conflict in &merged.conflicts {
        merger.resolve_path(conflict)?;
    }
    if let Some(base) = merger.base.clone() {
        merger.restore_deleted_entities(&base, &merged.tree)?;
    }

    let tree = if merger.edits.is_empty() {
        merged.tree
    } else {
        let edits: Vec<TreeEdit> = std::mem::take(&mut merger.edits)
            .into_iter()
            .map(|(path, blob)| match blob {
                Some(b) => TreeEdit::Upsert {
                    path,
                    mode: b.mode,
                    oid: b.oid,
                },
                None => TreeEdit::Remove { path },
            })
            .collect();
        git.edit_tree(repo, &merged.tree, &edits)?
    };
    Ok(MergeOutcome {
        tree,
        conflicts: merger.conflicts,
    })
}

struct Merger<'a> {
    git: &'a dyn GitBackend,
    repo: &'a Path,
    ours: &'a Oid,
    theirs: &'a Oid,
    base: Option<Oid>,
    local_label: &'a str,
    /// Final content per path; `None` removes the path.
    edits: BTreeMap<String, Option<BlobRef>>,
    conflicts: Vec<ResolvedConflict>,
}

impl Merger<'_> {
    fn set(&mut self, path: &str, blob: &BlobRef) {
        self.edits.insert(path.to_string(), Some(blob.clone()));
    }

    fn report(&mut self, path: &str, resolution: Resolution) {
        self.conflicts.push(ResolvedConflict {
            path: path.to_string(),
            resolution,
        });
    }

    fn resolve_path(&mut self, c: &ConflictEntry) -> Result<()> {
        match (&c.ours, &c.theirs) {
            (Some(ours), Some(theirs)) => match layout::file_kind(&c.path) {
                FileKind::Markdown => self.merge_markdown(c, ours, theirs),
                FileKind::Json => self.merge_json(c, ours, theirs),
                FileKind::Other => self.keep_newest_with_copy(&c.path, ours, theirs),
            },
            (Some(kept), None) | (None, Some(kept)) => {
                self.set(&c.path, kept);
                self.report(&c.path, Resolution::KeptEditOverDelete);
                Ok(())
            }
            (None, None) => Ok(()),
        }
    }

    fn merge_markdown(&mut self, c: &ConflictEntry, ours: &BlobRef, theirs: &BlobRef) -> Result<()> {
        let base = match &c.base {
            Some(base) => base.oid.clone(),
            None => self.git.write_blob(self.repo, b"")?,
        };
        let remote_label = self.remote_label(&c.path)?;
        let merged = self.git.merge_text(
            self.repo,
            &base,
            &ours.oid,
            &theirs.oid,
            [self.local_label, "base", &remote_label],
            text_merge::MARKER_SIZE,
        )?;
        let content = if merged.conflicts > 0 {
            text_merge::rewrite_conflicts(&merged.content, self.local_label, &remote_label)
        } else {
            merged.content
        };
        let oid = self.git.write_blob(self.repo, &content)?;
        self.set(
            &c.path,
            &BlobRef {
                mode: ours.mode.clone(),
                oid,
            },
        );
        if merged.conflicts > 0 {
            self.report(&c.path, Resolution::KeptBothVersions);
        }
        Ok(())
    }

    fn merge_json(&mut self, c: &ConflictEntry, ours: &BlobRef, theirs: &BlobRef) -> Result<()> {
        let parse = |blob: &BlobRef| -> Result<Option<Value>> {
            Ok(serde_json::from_slice(&self.git.read_blob(self.repo, &blob.oid)?).ok())
        };
        let base = match &c.base {
            None => None,
            Some(base) => match parse(base)? {
                Some(value) => Some(value),
                None => return self.keep_newest_with_copy(&c.path, ours, theirs),
            },
        };
        let (ours_value, theirs_value) = match (parse(ours)?, parse(theirs)?) {
            (Some(o), Some(t)) => (o, t),
            // Hand-edited into invalid JSON on one side: the valid version
            // wins and the broken one is kept for the user to look at.
            (Some(_), None) => {
                let label = self.remote_label(&c.path)?;
                return self.keep_with_copy(&c.path, ours, theirs, &label);
            }
            (None, Some(_)) => {
                let label = self.local_label.to_string();
                return self.keep_with_copy(&c.path, theirs, ours, &label);
            }
            (None, None) => return self.keep_newest_with_copy(&c.path, ours, theirs),
        };

        let (merged, fields) = {
            let this = &*self;
            let mut pick =
                |key_path: &[String]| this.newest_side(&c.path, &|blob| this.json_probe(blob, key_path));
            json_merge::merge(base.as_ref(), &ours_value, &theirs_value, &mut pick)?
        };
        let oid = self
            .git
            .write_blob(self.repo, &json_merge::to_canonical_bytes(&merged))?;
        self.set(
            &c.path,
            &BlobRef {
                mode: ours.mode.clone(),
                oid,
            },
        );
        if !fields.is_empty() {
            self.report(&c.path, Resolution::NewestFieldsWon { fields });
        }
        Ok(())
    }

    fn keep_newest_with_copy(&mut self, path: &str, ours: &BlobRef, theirs: &BlobRef) -> Result<()> {
        let side = self.newest_side(path, &|blob| Ok(blob.map(|b| b.to_string())))?;
        let (winner, loser, loser_label) = match side {
            Side::Ours => (ours, theirs, self.remote_label(path)?),
            Side::Theirs => (theirs, ours, self.local_label.to_string()),
        };
        self.keep_with_copy(path, winner, loser, &loser_label)
    }

    fn keep_with_copy(
        &mut self,
        path: &str,
        winner: &BlobRef,
        loser: &BlobRef,
        loser_label: &str,
    ) -> Result<()> {
        let copy = layout::conflict_copy_path(path, loser_label, loser.oid.short());
        self.set(path, winner);
        self.set(&copy, loser);
        self.report(path, Resolution::KeptNewestWithCopy { copy });
        Ok(())
    }

    /// A page or database deleted on one side but changed on the other is
    /// restored as a whole, so it never ends up half-present.
    fn restore_deleted_entities(&mut self, base: &Oid, merged_tree: &Oid) -> Result<()> {
        let entities = |paths: Vec<String>| -> BTreeSet<String> {
            paths
                .iter()
                .filter_map(|p| layout::dir_entity(p))
                .map(String::from)
                .collect()
        };
        let ours_changed = entities(self.git.changed_paths(self.repo, base, self.ours)?);
        let theirs_changed = entities(self.git.changed_paths(self.repo, base, self.theirs)?);

        for entity in ours_changed.intersection(&theirs_changed) {
            if self.git.list_tree(self.repo, base, Some(entity))?.is_empty() {
                continue;
            }
            let ours = self.git.list_tree(self.repo, self.ours, Some(entity))?;
            let theirs = self.git.list_tree(self.repo, self.theirs, Some(entity))?;
            let source = match (ours.is_empty(), theirs.is_empty()) {
                (true, false) => theirs,
                (false, true) => ours,
                _ => continue,
            };

            let keep: BTreeSet<&str> = source.iter().map(|e| e.path.as_str()).collect();
            self.edits
                .retain(|path, _| !layout::is_within(path, entity) || keep.contains(path.as_str()));
            for entry in self.git.list_tree(self.repo, merged_tree, Some(entity))? {
                if !keep.contains(entry.path.as_str()) {
                    self.edits.insert(entry.path, None);
                }
            }
            for entry in &source {
                self.set(
                    &entry.path,
                    &BlobRef {
                        mode: entry.mode.clone(),
                        oid: entry.oid.clone(),
                    },
                );
            }
            self.conflicts.retain(|c| !layout::is_within(&c.path, entity));
            self.report(entity, Resolution::RestoredDeleted);
        }
        Ok(())
    }

    /// The side whose current value (as seen through `probe`) was set most
    /// recently. Ties go to the remote: its version is already published.
    fn newest_side(&self, path: &str, probe: Probe<'_>) -> Result<Side> {
        let ours = self.last_set_time(self.ours, path, probe)?;
        let theirs = self.last_set_time(self.theirs, path, probe)?;
        Ok(if ours > theirs { Side::Ours } else { Side::Theirs })
    }

    /// Time of the newest commit on `tip`'s side of the merge that set the
    /// value (as seen through `probe`) to what it is at `tip`.
    fn last_set_time(&self, tip: &Oid, path: &str, probe: Probe<'_>) -> Result<Option<i64>> {
        let value_at = |rev: &str| -> Result<Option<String>> {
            let blob = self.git.resolve(self.repo, &format!("{rev}:{path}"))?;
            probe(blob.as_ref())
        };
        let current = value_at(tip.as_str())?;
        let history = self.git.path_history(self.repo, self.base.as_ref(), tip, path)?;
        for commit in &history {
            if value_at(commit.oid.as_str())? != current {
                continue;
            }
            if value_at(&format!("{}^", commit.oid))? != current {
                return Ok(Some(commit.time));
            }
        }
        Ok(history.first().map(|c| c.time))
    }

    fn json_probe(&self, blob: Option<&Oid>, key_path: &[String]) -> Result<Option<String>> {
        let Some(blob) = blob else { return Ok(None) };
        let bytes = self.git.read_blob(self.repo, blob)?;
        Ok(serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| json_merge::value_at(&v, key_path).map(Value::to_string)))
    }

    /// Name of the device that last changed `path` on the remote side.
    fn remote_label(&self, path: &str) -> Result<String> {
        let history = self
            .git
            .path_history(self.repo, self.base.as_ref(), self.theirs, path)?;
        Ok(history
            .first()
            .map(|c| c.author.clone())
            .filter(|a| !a.is_empty())
            .unwrap_or_else(|| "remote".to_string()))
    }
}
