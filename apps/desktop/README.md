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
- **Conflicts.** A place two devices edited at once is a block in the page,
  with a bar over each version that says who wrote it ("You" for the person
  signed in here) and on which device, and "Keep this version" / "Keep both"
  (`packages/editor`). A line above the page says how many there are and
  jumps to the first. A conflict the editor can't draw as a block, such as
  one inside a code block, is listed above the page with "Keep this one"
  (`docsync::conflicts`). The device's name is set in Settings › Preferences
  and kept in the app's `settings.json`.
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
  `SAWMILL_GITHUB_CLIENT_SECRET`. Without it the app signs in with a code
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
| ⌘J / ⌘⇧J | Developer panel / fill the window with it |

The shortcuts live in `src/shortcuts.ts`, so tooltips and the overview stay
in step with them.

## Development and release builds

They are two apps that never share data. `npm run tauri dev` (and a plain
`tauri build`) makes **Sawmill Dev**, `dev.sawmill.app.dev`, with a light
icon: the saw on Paper instead of Ink (`src-tauri/icons-dev`, drawn from
`assets/icon-dev.svg`). Release builds add `src-tauri/tauri.release.conf.json`, which makes **Sawmill**,
`dev.sawmill.app`. The identifier sets the app's settings and data folders,
its log folder and its keychain service, so a development build never opens
or changes the workspaces of the installed app. Both can sync the same
workspace from GitHub or a cloud folder; the workspace format version keeps
an older one from damaging what a newer one wrote
([sync-design.md](../../docs/sync-design.md#on-disk-format)).

Changing the identifier gives the app new, empty folders and keychain
entries; the old ones are left as they were. After such a change, join
workspaces again from GitHub or the cloud folder and sign in again.

## Releases

Push a tag and GitHub Actions builds the app and publishes it as a GitHub
Release (`.github/workflows/release.yml`):

```sh
git tag v0.2.0 && git push origin v0.2.0
```

The tag sets the version. For now it builds for Apple Silicon Macs only.

- **Updates.** Release builds check the latest release 20 seconds after
  starting and every 4 hours (`src-tauri/src/updater.rs`), download and
  install a newer version in the background, and show an arrow at the
  bottom of the sidebar: "Restart to update". Otherwise the new version runs
  from the next start. Update files are signed with a key of our own (the
  public half is in `tauri.release.conf.json`); the private key and its
  password are the `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets. Losing them means installed
  apps can no longer update themselves.
- **Signing.** Until there is an Apple Developer account, the app is signed
  with a self-made certificate (`scripts/make-signing-cert.sh`, secrets
  `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` and
  `APPLE_SIGNING_IDENTITY`). It doesn't get past Gatekeeper, so the first
  install from the `.dmg` needs "Open Anyway" in System Settings › Privacy &
  Security (the install command, `scripts/install.sh`, downloads with curl,
  which macOS doesn't flag, so it skips that), but
  it gives every release the same signature, so macOS keeps letting the
  updated app read its keychain items (the GitHub sign-in). Keep the
  certificate: a new one asks for keychain access again.
- **GitHub sign-in.** The `SAWMILL_GITHUB_CLIENT_SECRET` secret, as in
  `build.rs`. Without it, releases sign in with a code instead of the
  browser.

To try a release build locally, without the certificate (so ad hoc
signed):

```sh
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/sawmill-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/sawmill-updater.key.password)"
npx tauri build --bundles app --config src-tauri/tauri.release.conf.json
```

## Log file

Every build writes its log to a file as well, in the app's log folder
(`~/Library/Logs/dev.sawmill.app/sawmill.log` on macOS, `…app.dev` for
development builds). Settings › About › Log file shows it. It holds the same
entries as the developer log below, never page text, and moves to
`sawmill.1.log` at 5 MB. Crashes are logged too.

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

## Databases (developer panel)

The panel's **Databases** tab lists the workspace's databases
(`src/DatabasesPanel.tsx`) and shows the chosen one as a table
(`src/TableView.tsx`), the view agents' standard views will build on.
Create, rename and delete databases; add columns (text, number, select,
checkbox, date, URL), and click a column's name to rename it, change its
type, edit a select's choices, sort, move or delete it. Cells edit in place
and save when you leave them (Enter moves down a row); a new choice typed
into a select becomes one of its choices. Sorting is for this window only.
Edits show at once and the database is then read back from disk, so a sync
or another program's edits show up too. The commands, which check each
value against its column's type, are in `src-tauri/src/databases.rs`; the
format is in `docsync::database`.

## Database pages

"New database" in the sidebar makes a page that shows a database
(`src/DatabasePageView.tsx`), with views as tabs: a **table**
(`src/TableView.tsx`) or a **board** (`src/BoardView.tsx`, lanes from a
select or checkbox column; drag cards between lanes, click one to edit its
fields). Click the open tab for its settings: name, layout, what a board
groups by, delete. Views and their sort are stored in the page's
`meta.json` and sync; the open tab is per device. Editing goes through
`src/useDatabase.ts`, shared with the developer panel. The commands are in
`src-tauri/src/database_pages.rs`; the format is in
`docsync::database_page`.

Every row is a page too: open it from the button by its row number in a
table, or by clicking its card on a board. Its title is the first text
column and its other columns show as properties under the title. Any page
can have properties (`src/PageProperties.tsx`; "Add a property" shows when
you point at the title): click a property's name to rename it, change its
type or delete it. The commands, which treat a page and a row alike, are in
`src-tauri/src/page_properties.rs`.

Not yet: the block handle, table
controls, search, signing and updates. See the [roadmap](../../docs/roadmap.md).
