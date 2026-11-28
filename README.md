<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/logo/sawmill-logo-dark.svg">
    <img src="brand/logo/sawmill-logo-light.svg" height="56" alt="Sawmill">
  </picture>
</h1>

A free, open-source workspace for humans and AI agents. Your pages and
databases are plain files in a git repository you own.

> **Work in progress.** Sawmill is early and changes quickly. It is usable,
> but expect rough edges, missing features and breaking changes, and keep
> your workspaces synced to a git remote so nothing lives only on one
> machine.

## Install

macOS on Apple Silicon only, for now. Paste this in Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/egges/sawmill/main/scripts/install.sh | sh
```

It downloads the latest release, puts Sawmill in Applications and opens
it. Run it again any time to reinstall.

Or install it by hand:

1. Download the `.dmg` from the
   [latest release](https://github.com/egges/sawmill/releases/latest).
2. Open it and drag **Sawmill** to Applications.
3. Open Sawmill. The first time, macOS blocks it, because the app isn't
   notarized by Apple yet. Go to **System Settings › Privacy & Security**,
   scroll down to the message about Sawmill and click **Open Anyway**.
   This is needed only once.

After that, Sawmill updates itself: it downloads new versions in the
background, and a "Restart to update" button appears at the bottom of the
sidebar when one is ready.

If something goes wrong, the log is in Settings › About › Log file.

## Status

The first building block is in place: **`docsync`**, the sync engine
(`crates/docsync`). It keeps a workspace in sync between devices through any
git remote and resolves every conflict automatically, so users never see git.

- Design, conflict rules and the guarantees the tests check:
  [docs/sync-design.md](docs/sync-design.md)
- Run the tests: `cargo test`
- Run a longer randomized soak test:
  `DOCSYNC_SIM_SEEDS=300 DOCSYNC_SIM_STEPS=150 cargo test --release --test simulation`

The second is the **page editor** (`packages/editor`): Milkdown, set up so
saving a page only changes the lines someone edited. See
[packages/editor/README.md](packages/editor/README.md); try it with
`cd packages/editor && npm install && npm run dev`.

The third is the **desktop app** (`apps/desktop`): Tauri 2 + React, with a
page tree, the editor, conflict resolution and background sync. See
[apps/desktop/README.md](apps/desktop/README.md); run it with
`cd apps/desktop && npm install && npm run tauri dev`.

Requires Rust 1.89+ and git 2.43+ (Rust 1.90+ and Node 24+ for the app and
the editor). The desktop app ships with its own git.

## Next

The plan, in order, with what is done: [docs/roadmap.md](docs/roadmap.md).
Bugs, features and chores are tracked in
[GitHub issues](https://github.com/egges/sawmill/issues).

Where it is going: the place a company's team works, with pages, conversation
and agents that do much of the work, all in git repositories the company
owns. The direction and what has been decided are in
[docs/product-design.md](docs/product-design.md), and how an agent is defined
in [docs/agents-design.md](docs/agents-design.md).
