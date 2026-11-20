# Roadmap

Sync was the riskiest part, and it now has a tested foundation
([sync-design.md](sync-design.md)). This is the order for the rest.

Two unknowns could still change the design: Windows behaviour (now covered by
CI) and whether the editor can round-trip Markdown without rewriting it. The
editor test in step 3 comes first for that reason; everything else is mostly
straightforward building.

## 1. Harden what we have — done

- [x] **Continuous integration.** Lint and tests on Linux for every PR and
      push to `main` (`.github/workflows/ci.yml`).
- [x] **Windows.** The full test suite runs on Windows in the nightly
      workflow, alongside a long randomized sync simulation on Linux
      (`.github/workflows/nightly.yml`). macOS runs on demand.
- [x] **Merge the sync engine** (PR #1).

## 2. Finish the sync layer for real-world use

- [ ] **When to sync.** Commit shortly after each edit, sync every 30–60
      seconds and whenever the app gains focus, and watch for files changed
      outside the app.
- [ ] **Resolving conflict blocks.** A small function that keeps one version
      of a conflict block, so the editor and AI agents resolve it the same way.
- [ ] **Signing in.** GitHub sign-in, with the token stored in the system
      keychain and passed to Git through `CliGit::with_config`. A "create a
      private repo for me" onboarding step using the GitHub API, so
      non-developers never have to set up a remote themselves.
- [ ] **Orphaned pages.** Show pages whose parent was deleted at the top level.

## 3. Desktop app (the bulk of the work)

- [ ] **Editor round-trip test — do this first.** Check whether Tiptap or
      BlockNote can open and save Markdown without changing it. If the editor
      reformats pages on every save, it creates noisy commits and needless
      conflicts. Test it against a set of example Markdown files before
      building any other UI.
- [ ] **App shell.** Tauri 2 + React, calling `docsync` directly from the Rust
      side.
- [ ] **Pages and databases.** A page tree, a page view, a database table
      view, and the conflict block as a UI component.
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
