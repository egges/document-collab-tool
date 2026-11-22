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
- [x] **Default location.** New and joined workspaces go in the app's local
      data folder unless the user picks one, and "Show in Finder" reveals it
      ([sync-design.md](sync-design.md#the-local-copy)).
- [x] **Renaming workspaces.** The name lives in `workspace.json` and syncs;
      folders and remotes keep theirs. Click the name in the sidebar to
      rename ([sync-design.md](sync-design.md#renaming)).
- [ ] **Workspace list and moving.** Known workspaces in `settings.json`, a
      switcher, "Locate…" for a missing folder, and "Move…" in settings.
- [ ] **Cloud folder remotes.** A bare repo in iCloud Drive, Dropbox or
      OneDrive with one ref per device, tested with delayed, unordered
      copying ([sync-design.md](sync-design.md#cloud-folder-remotes)).
- [ ] **Sync setup.** One "Where should your notes sync?" choice in
      onboarding and settings, detecting installed cloud folders, finding
      `*.docsync` workspaces to join, and a safe setup when a workspace sits
      inside a cloud folder.
- [ ] **Sharing.** A "Share" button: the provider's share sheet for cloud
      folders, invite and accept for GitHub; commits record the person, not
      just the device.

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
- [x] **Editor: blocks.** As in Notion: a handle left of each block (and
      each list item) with "+" to add a block and a grip to drag it, a
      block menu (turn into, duplicate, copy, move, delete), and keys (Esc
      selects a block, ⌘D duplicates, ⌘⇧↑ / ⌘⇧↓ move). Turning a list item
      or quote into text now takes it out of the list or quote.
- [ ] **Editor: tables.** Add and remove rows and columns.
- [x] **Links and search.** Clicking a link opens it (in the browser, or the
      page it points to); hovering shows it with copy and edit (text, address, remove).
      ⌘K searches page titles and text. The sidebar can
      be resized and hidden (⌘\\).
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

## 4. Search, links and AI agents

The workspace is plain files in git, so the best way to bring in AI is to be
the place agents the developer already uses (Claude Code, Codex, Cursor) can
work in, rather than shipping our own agent first.

- [ ] **Local search.** A SQLite full-text index stored in `.docsync/`, which
      is never synced, to replace the plain scan ⌘K uses now.
- [ ] **Links between pages.** Typing `[[` opens a menu of pages, filtered as
      you type, and inserts a normal Markdown link to the page's id
      (`[Title](../<id>/page.md)`, the format `links.ts` already reads), so
      links still work on GitHub, in other editors and for agents, and
      survive renames. "Create page …" when nothing matches.
- [ ] **Backlinks.** "Linked from N pages" at the bottom of each page, with
      the sentence around each link. A reverse link index next to the search
      index in `.docsync/`. Later: unlinked mentions (the title as plain text,
      with "link it"), and "update N links to the new title" after a rename.
- [ ] **MCP server.** Built on the same crate, with tools to search, read
      pages, create and update pages, query databases and list backlinks.
      Writes go through the same merge as the editor, so they never fight an
      open page. Commits made by agents are credited to something like
      "Claude (via MCP)", so the history shows which changes came from AI.
- [ ] **CLI.** The same operations from the terminal and scripts, for
      developers and for the hooks in step 9.

## 5. Developer essentials

- [ ] **Diagrams and math.** Mermaid code blocks drawn as diagrams, and math
      (`$…$` and `$$…$$`), both stored as plain Markdown.
- [ ] **Keyboard first.** Every action reachable from the keyboard, with a
      command menu, and an optional vim mode in the editor.
- [ ] **Open elsewhere.** "Open in terminal" and "Open in editor" for the
      workspace folder. (Instead of a terminal built into the app: developers
      already have one they like.)

## 6. Page history and agent review

Git already has every version; this makes it visible.

- [ ] **Page history.** A timeline for each page: who or what changed it
      (person, device or agent) and when, with a diff and "restore this
      version".
- [ ] **What changed.** "Changed since you last looked" on pages, and a
      list of recent changes across the workspace.
- [ ] **Reviewing agent edits.** Changes made through MCP shown as a diff to
      accept or revert, page by page, so users can trust agents with their
      notes.

## 7. Working together

Everything lives in the workspace's git repo, so collaboration works the same
on every sync target, with no service of our own. That shapes what is
possible: collaboration is asynchronous (changes arrive with the next sync),
everyone with access sees every page and its history (the workspace is the
unit of sharing, see [sync-design.md](sync-design.md#sharing-with-other-people)),
and identity is trusted rather than verified, as in a shared folder.

- [ ] **People.** `people/<person-id>/profile.json` (name, colour, optional
      email) and a profile picture resized to a small size before it is
      saved, since git keeps every version. The id is random, not an email.
      Each device belongs to a person, and commits record the person as well
      as the device. Agents get a profile too, so their edits and comments
      show up like anyone else's. Device-only settings (theme, window,
      sidebar) stay out of the workspace.
- [ ] **Comments.** On a page or on a selection, with replies, resolve and
      reactions. Stored outside the page's Markdown so pages stay clean for
      other tools and agents, one file per comment so two people commenting
      at once never conflict. A comment on a selection remembers its block
      and the quoted text and finds them again after edits; if the text is
      gone, the comment says so instead of disappearing. Agents can comment
      through MCP.
- [ ] **Mentions.** `@` opens a menu of people (also pages and dates) and
      inserts a link to the person's id. A "person" column type for
      databases, for assigning rows.
- [ ] **Inbox.** Mentions, replies and changes to pages you follow, worked
      out on each device after a sync, since there is no server to send them.
      They only arrive when the app syncs and nothing reaches a closed app;
      hooks (step 9) can forward them to Slack or email.
- [ ] **Recent activity on a page.** "Anna edited this 2 minutes ago" when
      you open a page someone else just changed, and faster syncing while a
      page that others edit is open, so two people editing the same page at
      once is rare and visible rather than a surprise conflict.
- [ ] **Clear expectations about access.** The app says plainly that a
      workspace is shared as a whole, that anyone removed keeps the copy they
      already have, and that names and comments stay in the history. Private
      pages belong in a separate workspace. Read-only members come from the
      sync target (read access on GitHub, a view-only folder share).

## 8. Beta release

- [ ] Code signing and notarization for macOS
- [ ] Automatic updates
- [ ] Landing page
- [ ] Product name and domain

## 9. Hooks and automations

- [ ] **Events.** The app emits an event after a change is saved (not per
      keystroke): page created, changed, moved or deleted; database row
      created, changed or deleted; sync finished (with what came in from
      other devices); conflict found or resolved; site published. Each event
      says where the change came from: this device, another device, or an
      agent.
- [ ] **Scripts.** Scripts in the workspace subscribe to events and get the
      event as JSON on stdin; they can call the CLI to change the workspace.
      Examples: fill in a row's "done" date, post a changed page to Slack,
      regenerate an index page.
- [ ] **Safety.** Scripts sync like everything else, so a script written on
      another device or by another person never runs until it is approved on
      this device, and approval is tied to the script's contents. Each script
      chooses which devices run it, so an action does not happen once per
      device. Changes made by a script are credited to it and do not trigger
      that script again.
- [ ] **Events in the API.** Agents and other programs can subscribe to the
      same events through MCP and the CLI.

## 10. Publish to a static site

- [ ] **Build.** Turn a chosen page tree into a static site (HTML, CSS and
      assets) on the device. Only the pages chosen are published.
- [ ] **GitHub Pages.** Push the built site, with a `.nojekyll` file, to a
      separate public repo (for example `username.github.io`), never the
      workspace repo, which stays private. Turn on Pages through the GitHub
      API with the same sign-in as sync. No GitHub Actions needed.
- [ ] **GitLab Pages.** The same, plus a small `.gitlab-ci.yml` whose `pages`
      job only copies the built files (GitLab always deploys Pages from CI).
- [ ] **Without a git host.** For workspaces synced through a cloud folder:
      direct upload to Cloudflare Pages or Netlify.

## Later

Ideas we want, in roughly this order, once the steps above are done.

- **Runnable code blocks.** A run button on shell code blocks, with the
  output shown in the page, for runbooks.
- **AI-built blocks.** Custom UI blocks an agent builds, which read and
  write databases. Each block is a file in the workspace (HTML/JS and a
  manifest saying which databases it may use), runs in a sandboxed iframe,
  and reaches data only through a narrow API.
- **Writing commands.** "Improve writing" and similar, using the user's own
  agent or API key, with the result shown as a suggested change to accept.
- **Live presence and co-editing.** Who is viewing a page, live cursors and
  editing a page together in real time. Git cannot do this, so it needs a
  live channel between devices (on the local network or through a small
  optional relay), with git still the record.
- **Signed commits.** Signing with each person's key, so names in the
  history can be verified.
- **Docs in code repos.** Edit a code repo's `docs/` folder or README in the
  app, working on a branch and opening a pull request instead of syncing to
  `main`.
