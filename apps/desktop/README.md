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

Needs Rust 1.90+, Node 24+ and Git 2.43+ (the app finds `git` on `PATH`, in
the usual install locations, or at `DOCSYNC_GIT`; bundling it is a later
step). On Linux, install
[Tauri's system dependencies](https://tauri.app/start/prerequisites/) first.

## What it does

- **Workspaces.** Pick a folder: an existing workspace opens, an empty folder
  gets a new one. Or join one from another device by its Git URL. The last
  workspace reopens on start.
- **Pages.** A page tree (pages whose parent was deleted on another device
  show at the top level), a title, and the editor. Create, rename and delete
  pages. Drag the sidebar's edge to resize it (double-click resets it); its
  width and whether it's shown are kept per device.
- **Title bar.** The app draws its own (`src/TitleBar.tsx`): over the
  sidebar, the button to hide it; over the page, where the page sits in the
  tree (click a level to open it) and Delete. Empty parts move the window.
  On macOS the window's own buttons sit in its corner
  (`src-tauri/tauri.macos.conf.json`, `src/windowChrome.ts`); on Windows and
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
  SSH URLs and local paths work. HTTPS to GitHub needs sign-in, which isn't
  built yet. Git never prompts: SSH runs in batch mode, so the host key must
  already be trusted and the key loaded in the agent.

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

Not yet: GitHub sign-in, bundled Git, databases, the block handle, table
controls, search, signing and updates. See the [roadmap](../../docs/roadmap.md).
