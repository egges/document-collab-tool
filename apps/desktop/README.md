# Desktop app

Tauri 2 + React. The Rust side (`src-tauri`) opens a workspace with
[`docsync`](../../crates/docsync) and decides when to commit and sync. The
window (`src`) shows the page tree and the [page editor](../../packages/editor).

```sh
(cd ../../packages/editor && npm install)   # the app links the editor package
npm install
npm run tauri dev       # the app, with hot reload
npm test                # save logic (Vitest)
npm run typecheck
(cd src-tauri && cargo test)
```

Needs Rust 1.90+ and Node 24+. The app ships with its own Git: `tauri build`
runs `npm run fetch-git` first, which downloads GitHub Desktop's portable Git
([dugite-native](https://github.com/desktop/dugite-native), pinned with hashes
in `git.json`) for the target platform into `src-tauri/git`, leaving out Git
Credential Manager, Git LFS and Scalar. Tauri bundles that folder as a
resource. In development, run `npm run fetch-git` once to use it too;
otherwise the app uses an installed Git 2.43+ (on `PATH` or in the usual
install locations). `DOCSYNC_GIT` points the app at another git, ahead of
both. Universal macOS builds aren't supported yet. On Linux, install
[Tauri's system dependencies](https://tauri.app/start/prerequisites/) first.

## What it does

- **Workspaces.** Pick a folder: an existing workspace opens, an empty folder
  gets a new one. Or join one from another device by its Git URL. The last
  workspace reopens on start. Click the workspace name in the sidebar to
  switch between the workspaces this device knows, rename, or add one
  (`src/WorkspaceSwitcher.tsx`); double-clicking the name renames it. A
  workspace whose folder has gone shows "Locate…". "Move…" in the sync
  panel moves the workspace's folder (`src-tauri/src/workspaces.rs`).
  "Delete workspace…" moves its folder to the Trash and, if ticked, deletes
  its GitHub repository too (`src/DeleteWorkspace.tsx`).
- **Pages.** A page tree (pages whose parent was deleted on another device
  show at the top level), a title, and the editor. Create, rename and delete
  pages. Drag the sidebar's edge to resize it (double-click resets it); its
  width and whether it's shown are kept per device.
- **Title bar.** The app draws its own (`src/TitleBar.tsx`): the sidebar
  button, always in the same spot (the sidebar slides open and closed);
  over the page, where the page sits in the tree (click a level to open it)
  and Delete. Empty parts move the window and double-clicking zooms it
  (`src/windowChrome.ts`, which calls Tauri's window API itself).
  On macOS the window's own buttons sit in its corner
  (`src-tauri/tauri.macos.conf.json`, `src/windowChrome.ts`). Zooming
  (⌘+ / ⌘−, `src/zoom.ts`) scales the bar's icons and text but not its
  height, so they stay centred on those buttons; on Windows and
  Linux the system title bar stays above it for now.
- **Search** (⌘K). Finds pages by title and by the text the editor shows,
  without Markdown syntax or link addresses (`src-tauri/src/search.rs`, a
  plain scan until the full-text index exists). Opening a text match
  selects it in the page. Results come in sections (`src/search.ts`), so
  other kinds of results can be added later.
- **Links.** Clicking a link opens it: web and mail links in the browser or
  mail app, links to another page (a path with its id, such as
  `../<id>/page.md`) in the app (`src/links.ts`). Resting the pointer on a
  link shows its address with Copy and Edit; Edit changes the link's text
  and address, or removes the link.
- **Saving.** The body is written 0.6 s after the last change, when switching
  pages and when the window loses focus. Every write says which version the
  edit started from, and if the file changed since (a sync, an AI agent,
  another program), the Rust side merges both instead of overwriting
  (`SyncEngine::write_page_body`). The logic is in `src/pageSaver.ts`.
- **Commit and sync** (`src-tauri/src/worker.rs`). Commits 2 s after the last
  edit. Syncs on opening, every 45 s, on window focus (at most every 10 s) and
  on "Sync now". Watches the folder, so edits from other programs show up and
  get committed.
- **Conflicts.** A page with conflict blocks shows them above the editor, with
  "Keep this version" for each (`docsync::conflicts`). In the editor the
  markers show as labelled lines, so the versions can also be merged by hand.
- **Sync settings.** Click the status at the bottom of the sidebar to set the
  Git URL this device syncs with (stored per device in `.docsync/app.json`).
  HTTPS and SSH URLs and local paths work. Git never prompts: SSH runs in
  batch mode, so the host key must already be trusted and the key loaded in
  the agent.
- **Onboarding.** "Add a workspace" (`src/Welcome.tsx`): start a new
  workspace or join one. A workspace is kept in a folder ("On this
  computer" by default, or any folder you choose, such as one in Dropbox,
  OneDrive or iCloud Drive) or in a Git repository (GitHub or any URL),
  shown as two blocks. A new one is a single screen: the name, then the
  blocks. "Add workspace…" in the switcher opens it, and "Change…" in the
  sync panel shows the same blocks.
- **Folders.** A workspace syncs through a `<name>.docsync` folder in the
  chosen folder, with one ref per device (`src-tauri/src/cloud.rs`, and
  "Cloud folder remotes" in `docs/sync-design.md`). The installed cloud
  folders are shortcuts in the picker, and the `.docsync` folders in them are
  listed to join. A workspace whose own folder is inside a cloud folder gets
  moved out of it.
- **GitHub.** "Continue with GitHub" in the wizard signs in through the
  browser and installs the GitHub App if needed; the sign-in is kept in the
  keychain and GitHub HTTPS remotes use it. The wizard lists the workspaces
  already on GitHub to join, or creates a new private repo; the sync panel
  shows the account, to sign out. While signed in, commits are by the
  account's no-reply address. Debug builds keep the sign-in in
  `dev-sign-in.json` in the app's config folder instead (readable only by
  you), since macOS would ask for keychain access after every rebuild.

  The browser sign-in needs the GitHub App's client secret at build time:
  put it in `src-tauri/github-client-secret` (gitignored) or set
  `PAGEMESH_GITHUB_CLIENT_SECRET`. Without it the app signs in with a code
  (the device flow) instead.

## Keyboard

⌘ is Ctrl on Windows and Linux. ⌘/ shows them all in the app.

| | |
|---|---|
| ⌘K | Search page titles and text (or create a page with the typed title) |
| ⌘\\ | Show or hide the sidebar |
| ⌘N / ⌘⇧N | New page / new page inside the open one |
| ⌘⌥↑ / ⌘⌥↓ | Previous / next page |
| ⌘⇧⌫ | Delete the open page |
| ⌘S | Save and sync now |
| ⌘J / ⌘⇧J | Developer log / fill the window with it |

The shortcuts live in `src/shortcuts.ts`, so tooltips and the overview stay
in step with them.

## Developer log

Debug builds have a developer panel: press ⌘J (Ctrl+J on Windows and Linux)
or click the terminal icon at the bottom of the sidebar. It shows one
live timeline of what the app did: every git command with its exit code,
timing and error output, why each sync started and what it did, files
changed on disk, and each save (written, merged with changes on disk,
retried). Sources, levels and outcomes are colour-coded. Filter by source
or level, or search (⌘F); ⌘⇧J (or double-clicking the toolbar) makes the
log fill the window, and ⌘⇧C copies it. **Copy** puts the whole log
on the clipboard with the app version, OS, git and workspace details, ready
to paste into a bug report. The log never contains page text, only sizes and
page ids.

Release builds hide the panel. Set `DOCSYNC_DEV=1` to turn it on anyway.
Debug builds also print every entry to the terminal.

Not yet: databases, the block handle, table
controls, search, signing and updates. See the [roadmap](../../docs/roadmap.md).
