# Roadmap

Sync was the riskiest part, and it now has a tested foundation
([sync-design.md](sync-design.md)). This is the order for the rest.

The two unknowns that could have changed the design are settled: Windows
behaviour is covered by CI, and the editor test in step 3 found an editor
that round-trips Markdown well enough. Everything else is mostly
straightforward building.

## 1. Harden what we have — done

- [x] **Continuous integration.** Lint and tests on Linux for every PR and
      push to `main` (`.github/workflows/ci.yml`).
- [x] **Windows.** The full test suite runs on Windows in the nightly
      workflow, alongside a long randomized sync simulation on Linux
      (`.github/workflows/nightly.yml`). macOS runs on demand.
- [x] **Merge the sync engine** (PR #1).

## 2. Finish the sync layer for real-world use

- [x] **When to sync.** The app commits 2 seconds after the last edit, syncs
      every 45 seconds and when the window gains focus, and watches the folder
      for files changed outside the app (`apps/desktop/src-tauri/src/worker.rs`).
      Saving an open page merges with changes made meanwhile instead of
      overwriting them (`SyncEngine::write_page_body`).
- [x] **Resolving conflict blocks.** `docsync::conflicts` finds conflict
      blocks and keeps one version, so the editor and AI agents resolve them
      the same way.
- [ ] **Signing in.** GitHub sign-in, with the token stored in the system
      keychain and passed to Git through `CliGit::with_config`. A "create a
      private repo for me" onboarding step using the GitHub API, so
      non-developers never have to set up a remote themselves.
- [x] **Orphaned pages.** The app shows pages whose parent was deleted at the
      top level.

## 3. Desktop app (the bulk of the work)

- [x] **Editor round-trip test.** Compared Tiptap, BlockNote and Milkdown on
      12 example pages ([spikes/editor-roundtrip](../spikes/editor-roundtrip)).
      Result: **Milkdown**, with remark set to `-` bullets and unpadded
      tables. It keeps raw HTML and footnotes, and after a page's first save
      a one-word edit changes one line.
- [x] **Editor package** (`packages/editor`). Milkdown with our house style,
      the example pages as regression tests, and a demo page. The editor
      only writes a page when the user changed it, and refuses to save if
      the result would lose visible text. Menus are our own, in React: a
      toolbar on selection and a `/` menu. (Crepe, Milkdown's ready-made
      editor, was ruled out because it brings in Vue.)
- [x] **Editor: code blocks** (PR #8). ```` ``` ```` starts one, the code is
      highlighted (lowlight, about 35 languages), and the language is
      detected on paste or when you leave the block, then written into the
      fence. A searchable language menu and a copy button. Code-editor keys:
      paired brackets, auto-indent, moving and copying lines, ⌘/ to comment.
- [ ] **Editor: block handle.** A grip next to each block for dragging and a
      block menu.
- [ ] **Editor: tables and links.** Add and remove rows and columns, and edit
      a link by clicking it.
- [ ] **Importer.** Move front matter into `meta.json` before a page reaches
      the editor.
- [x] **App shell** (`apps/desktop`). Tauri 2 + React, calling `docsync`
      directly from the Rust side. Opens, creates or joins a workspace and sets
      the remote this device syncs with.
- [x] **Pages.** A page tree, a page view with the editor, and conflict blocks
      shown above the page with "keep this version".
- [ ] **Databases.** A database table view.
- [ ] **Conflict markers in the editor.** They show as labelled lines; a
      proper block with each version's device name would be clearer.
- [ ] **Bundled Git.** Ship Git with the app for each platform.

## 4. Search and AI

- [ ] **Local search.** A SQLite full-text index stored in `.docsync/`, which
      is never synced.
- [ ] **MCP server.** Built on the same crate, with tools to search, read
      pages, create and update pages, and query databases. Commits made by
      agents are credited to something like "Claude (via MCP)", so the history
      shows which changes came from AI.

## 5. Beta release

- [ ] Code signing and notarization for macOS
- [ ] Automatic updates
- [ ] Landing page
- [ ] Product name and domain
