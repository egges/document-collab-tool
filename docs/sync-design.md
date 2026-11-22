# Sync design

The `docsync` crate (`crates/docsync`) keeps a workspace of plain files in sync
between devices through any git remote. Users never see commits, branches or
conflict markers.

## On-disk format

```text
workspace.json                      workspace settings: {"format", "name"}
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

## Where workspaces live and what they sync with

### The local copy

Each device keeps its own working copy of a workspace. Unless the user picks
a folder, it goes in the app's local data folder:

| OS | Folder |
|---|---|
| macOS | `~/Library/Application Support/<app>/workspaces/<name>` |
| Windows | `%LOCALAPPDATA%\<app>\workspaces\<name>` |
| Linux | `~/.local/share/<app>/workspaces/<name>` |

Not `~/Documents`: on many Macs iCloud syncs it ("Desktop & Documents
Folders"), and on Windows OneDrive often does, which would put a working copy
with `.git` inside a cloud folder (see below). The app's data folder is never
synced, never triggers a macOS permission prompt, and Time Machine and File
History still back it up. Not Windows' Roaming folder either: roaming profiles
copy it between machines.

The files stay one click away: "Show in Finder" (Explorer, Files) in the sync
panel, and the folder path there opens it too. Users who want control can
choose a location when creating or joining a workspace, or open any folder
that holds one. Folder names come from the workspace name, made safe for every
platform; a name that's taken gets a number ("My Notes 2"). The code is in
`apps/desktop/src-tauri/src/locations.rs`.

### Renaming

The workspace's name is the `name` field in `workspace.json`, so it syncs like
any other field: every device and every collaborator sees the same name, and
if two people rename at once the newest edit wins. A new workspace stores its
name when it's created; one made before names were stored shows its folder
name until someone renames it.

Renaming never touches folders or remotes. The local folder is an internal
detail like a page id: renaming it would disturb the file watcher, the sync
lock and the remembered last workspace, fails on Windows while a file is open,
and may be a folder the user chose and named. Renaming a `.docsync` folder in
iCloud would break every other device's remote path. "Move…" can later suggest
the current name as the new folder name. Discovery of `*.docsync` workspaces
should read the name with `git show HEAD:workspace.json`, not use the folder
name.

In the app, clicking the name in the sidebar header edits it in place: Enter
or leaving the field saves, Escape cancels, an empty name keeps the old one. A
rename from another device shows up after the next sync.

Still to build: a check that offers a safe setup when the chosen location
is inside a cloud folder.

### The workspace list

Each device keeps a list of the workspaces it has opened in the app's
`settings.json` (never synced), with each one's name as last seen, so a
workspace whose folder has gone (moved in Finder, a drive that isn't
plugged in) still shows by name. Clicking the workspace name in the sidebar
opens the list to switch; the welcome screen shows it too. A missing folder
offers "Locate…" (pick where it is now) and "Remove from list", which never
deletes files. Paths are compared through their real location, so the same
folder is never listed twice. The code is in
`apps/desktop/src-tauri/src/workspaces.rs`.

"Move…" in the sync panel moves the open workspace into a new folder, named
after it, inside a folder the user picks. It first stops the worker and the
file watcher, which waits for a running sync and commits pending edits, so
nothing writes while files move. Moving is a rename on the same disk and a
copy followed by removing the original across disks; if the copy fails, the
partial copy is removed and the workspace reopens where it was. Everything
moves together: history, the per-device remote in `.docsync/app.json` and
the search index. Other devices don't notice, since remotes never point at a
working copy.

### Never a working copy inside a cloud folder

Putting the workspace in Dropbox, iCloud Drive or OneDrive looks like the
obvious way to sync, and it breaks:

- Those services copy files one by one, in no particular order. Git expects
  its index, refs and objects to change together. A half-copied index, or a
  ref that arrives before its objects, corrupts the repository; two devices
  writing at once leave files like `index (conflicted copy)`.
- Two sync systems edit the same files. Dropbox replaces `page.md` while the
  engine merges it, and the conflict rules above stop applying.
- iCloud's "Optimize Mac Storage" removes local copies of files it thinks are
  unused, so git and the file watcher see files go missing.
- `.docsync/`, which must stay on one device, would sync too.

### Sync targets

Every target is a git remote, so the engine is the same for all of them:

| Target | For | Remote |
|---|---|---|
| None | One device | No remote. Adding one later pushes the whole history. |
| Cloud folder | Individuals, small teams on a shared folder | A bare repo in the folder, e.g. `~/Dropbox/My Notes.docsync`, as a `file://` remote |
| GitHub | People with GitHub accounts | A private repo the app creates after GitHub sign-in |
| Git URL | Developers | Any URL, under "Advanced" |
| Hosted (later) | Teams without GitHub | Our own git-over-HTTPS service with email accounts |

In the app this is one setting, `none | folder | github | git_url | hosted`,
that can be changed at any time. The status bar names it ("Synced via iCloud
Drive") rather than anything about git.

### Cloud folder remotes

A cloud folder only carries git objects, which are named by their content and
never change, so they survive being copied in any order. The refs are the
problem: two devices pushing at about the same time would both write
`refs/heads/main`, and the push retry above can't help because the other
device's push arrives seconds later. So a folder remote follows the same rule
as the file layout, one writer per file:

- **Each device pushes only to its own ref,**
  `refs/heads/devices/<device-id>`. Syncing fetches every device's ref,
  merges them locally with the usual `merge-tree` path, and pushes the result
  to this device's ref. No file in the shared repo has two writers.
- **The shared repo is never repacked.** `gc.auto` and ref packing are off,
  so git never rewrites a shared file.
- **The app watches the shared repo's `refs/`** and syncs as soon as another
  device's ref changes, instead of waiting for the next timed sync.
- **iCloud may not have downloaded the repo yet.** Ask it to (through
  `NSFileCoordinator`, or `brctl download` as a fallback); if it can't, treat
  it like being offline.

The cost is merging N device refs instead of one remote branch. The scenario
tests and the simulation need a folder-remote variant with delayed, unordered
copying to prove it converges. GitHub and other git hosts keep the single
`main` branch.

### Setting it up

Onboarding asks one question, "Where should your notes sync?":

1. **Only on this device.**
2. **iCloud Drive, Dropbox, OneDrive or Google Drive**, showing only the ones
   installed (`~/Library/Mobile Documents/com~apple~CloudDocs`,
   `~/Library/CloudStorage/*`, Dropbox's `info.json`, and the Windows
   equivalents). One click creates `<name>.docsync` there.
3. **GitHub:** sign in with the device flow; the app creates a private repo.
   "Any Git URL" sits under "Advanced".

Joining on another device needs no typing for cloud folders: the app looks for
`*.docsync` in those folders and offers "Found **My Notes** in your iCloud
Drive: open it?" If a user opens or creates a workspace inside a cloud folder,
the app offers one button to set it up safely: move the files to the local
folder and create the bare repo next to where they were.

### Sharing with other people

Git hosts grant access per repository, so **a workspace is the unit of
sharing**: everyone with access sees every page. Each target shares in its
own way, behind one "Share" button:

- **Cloud folder:** the provider's own sharing (Dropbox shared folders,
  iCloud Drive folder sharing via `NSSharingService`, OneDrive). Once someone
  accepts, the folder appears on their device and the `*.docsync` scan finds
  it. Per-device refs keep this safe however many people join. Anyone with
  access can also damage the shared repo, so the app should offer "restore the
  shared repo from this device"; every device has the full history.
- **GitHub:** the app invites by username
  (`PUT /repos/{owner}/{repo}/collaborators/{username}`, with "can view"
  mapped to read access), and on the invitee's device lists and accepts
  pending invitations (`GET /user/repository_invitations`) before cloning.
  Teams use an organization, which also allows inviting by email. Everyone
  needs a GitHub account.
- **Hosted (later):** invites by email or link, with owner, editor and viewer
  roles. It is a git server over HTTPS with our own sign-in in front, so the
  engine doesn't change; the token reaches git through
  `CliGit::with_config`.

Limits that follow from the git model:

- No per-page permissions. Sharing one page means a separate workspace, or
  checks on the hosted service's side.
- Read-only access needs a host that enforces it. On a shared folder, anyone
  who can read can usually write.
- Commits should record the person as well as the device, so conflict blocks
  and history say "Anna (Laptop)" rather than just "Laptop".
- Removing someone stops future syncs; they keep the copy they have.

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
