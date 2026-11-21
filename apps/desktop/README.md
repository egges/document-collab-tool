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
  pages.
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

Not yet: GitHub sign-in, bundled Git, databases, the block handle, table
controls, search, signing and updates. See the [roadmap](../../docs/roadmap.md).
