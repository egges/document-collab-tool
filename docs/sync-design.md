# Sync design

The `docsync` crate (`crates/docsync`) keeps a workspace of plain files in sync
between devices through any git remote. Users never see commits, branches or
conflict markers.

## On-disk format

```text
workspace.json                      workspace settings
pages/<page-id>/meta.json           {"id", "title", "parent", "properties": {...}}
pages/<page-id>/page.md             page body (Markdown)
pages/<page-id>/assets/...          attachments
databases/<db-id>/schema.json       {"id", "name", "columns": [...]}
databases/<db-id>/rows/<row>.json   {"id", "cells": {...}}
.docsync/                           per-device state (search index, caches), git-ignored
```

The format is designed so most concurrent edits never conflict:

- **One file per page and per database row.** Edits to different pages or rows
  touch different files.
- **Paths come from random ids, never titles.** Renaming or moving a page
  changes a JSON field, not a path. Rename detection is turned off entirely.
- **Canonical JSON.** Keys are sorted, one field per line, so git merges edits
  to different fields line by line.
- **No central index.** The hierarchy lives in each page's `parent` field, so
  there is no single file everyone edits.

Everything stays readable and editable without the app.

A page or database exists only if its `meta.json` or `schema.json` exists.
Git doesn't track folders, so an emptied folder can stay on disk after its
files were synced away. Readers must ignore such folders.

## The sync loop

`SyncEngine::sync()` does the following:

1. Takes an exclusive lock (`.git/docsync.lock`). The app, an MCP server and a
   CLI can share one workspace safely.
2. Removes stale git lock files left by a crashed process.
3. Commits all local edits.
4. Fetches. If the remote is unreachable, it stops here with `offline: true`.
   Edits are committed locally and go out on the next sync.
5. Then one of four cases:
   - **Up to date:** nothing to do.
   - **Local is ahead:** push.
   - **Remote is ahead:** fast-forward the working tree.
   - **Both changed:** merge (below), then push.
6. If the push is rejected because another device pushed in between, it goes
   back to step 4, up to `max_attempts` times.

The merge runs entirely in git's object database (`git merge-tree
--write-tree`). The working tree is only touched once the final merged commit
exists. That step uses `git read-tree -m -u`, which refuses to overwrite files
the user changed in the meantime. In that case the engine commits those edits
and retries, so typing during a sync is safe.

The working tree is updated *before* the branch ref. If the process dies in
between, the next sync records the new files as local edits on the old commit,
and that merges cleanly. The reverse order would make the next commit undo the
other device's changes. The crash tests catch exactly that bug.

## Conflict rules

| Situation | Resolution |
|---|---|
| Different lines of a page edited | Normal line merge |
| Same lines of a page edited | Both versions kept in a conflict block (below) |
| Different JSON fields edited | Field-by-field merge |
| Same JSON field edited | Most recent edit wins (a tie goes to the version already on the remote) |
| Field removed on one side, changed on the other | The change wins |
| File edited on one side, deleted on the other | The edit wins |
| Page or database deleted on one side, anything in it changed on the other | The whole page or database is restored |
| Attachment changed on both sides | Newest keeps the path, the other is saved as `name.conflict-<device>-<id>.ext` |
| JSON invalid on one side (hand-edited) | The valid version wins; the broken one is kept as a conflict copy |

"Most recent" means the commit time of the commit that last set that particular
field, so the app should call `commit_local()` shortly after each edit. Commit
times come from the device clocks, so a device with a badly wrong clock can win
ties it shouldn't. The losing value always remains in history.

Conflict blocks are HTML comments, so a page is still valid Markdown:

```markdown
<!-- sync-conflict:start -->
<!-- sync-conflict:version Laptop -->
The laptop's version.
<!-- sync-conflict:version Desktop -->
The desktop's version.
<!-- sync-conflict:end -->
```

The editor should render these blocks with a "keep this version" action.
Every resolution is listed in `SyncReport::conflicts` and in the merge commit
message.

## Git binary

`CliGit` runs a specific `git` executable. The desktop app ships its own copy,
so users never install git and every machine behaves the same. Git 2.43 or
newer is required (`CliGit::check_version`). Global and system git
configuration are ignored. Settings the app needs, such as an auth header, go
in through `CliGit::with_config`, which passes them via environment variables
so tokens don't show up in process listings.

The engine only talks to git through the `GitBackend` trait, which has about
20 small operations. An embedded backend such as gitoxide could replace
`CliGit` later and be verified by the same test suite.

## What the tests guarantee

Run them with `cargo test`. To use a specific git binary, set
`DOCSYNC_TEST_GIT=/path/to/git`.

- **`tests/scenarios.rs`:** each rule above, plus offline work, push races,
  edits during a sync, stale lock files, joining an empty remote and restarts.
- **`tests/crash_recovery.rs`:** crashes a merging sync at *every* git call,
  both just before and just after the call (so "the push reached the remote
  but we died" is covered). It then restarts and checks convergence and that
  every edit survived.
- **`tests/simulation.rs`:** three devices make random edits, deletions,
  offline periods, clock jumps and syncs, in random order. Then it checks:
  - **Convergence:** all devices have the same commit and identical files.
  - **Validity:** no raw git conflict markers, all JSON parses, no half-present
    pages or databases, no leftover merge state.
  - **No silent loss:** an edit may only be missing if the device that deleted
    it had already seen it, i.e. the edit's commit is an ancestor of the
    deleter's commit. JSON values may lose to a newer value, but must be
    something someone wrote. Content that no longer existed anyway doesn't
    count: a line its author added and removed again, or a value a newer
    edit overwrote.

  Scale it up with `DOCSYNC_SIM_SEEDS` and `DOCSYNC_SIM_STEPS`, and reproduce a
  failure with `DOCSYNC_SIM_SEED=<n>`.

## Known limitations / next steps

- **Orphaned child pages.** If a parent page is deleted while a child is edited
  elsewhere, the child comes back but its `parent` no longer exists. The app
  should show such pages at the top level.
- **Schema changes are not merged field by field.** Concurrent edits to a
  database's columns resolve as one value (newest wins).
- **No live collaboration.** This is asynchronous sync: no live cursors and no
  character-by-character merging.
- **Large attachments live in the repo.** Git LFS or a separate blob store is a
  later concern.
- **Authentication** (GitHub/GitLab sign-in, keychain storage) sits in the app
  and reaches git through `CliGit::with_config`.
