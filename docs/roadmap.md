# Roadmap

Sync was the riskiest part, and it now has a tested foundation
([sync-design.md](sync-design.md)). This is the order for the rest.

The two unknowns that could have changed the design of the note-taking app
are settled: Windows behaviour is covered by CI, and the editor test in
step 3 found an editor that round-trips Markdown well enough.

On 2026-11-25 the direction widened, from a note-taking app to the place a
company's team works, with agents doing much of the work
([product-design.md](product-design.md)). Steps 4 to 10 follow from that.
Steps 4 to 7 need no server. The first server, a small relay, comes with
chat in step 8. The app is for our own team until step 10.

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
- [x] **Signing in.** GitHub sign-in with the device flow through a GitHub
      App limited to the repositories the user picks, the tokens in the
      system keychain and renewed in the background, passed to Git per
      command (`CliGit::with_config_source`). "Create a private repo on
      GitHub" in the sync panel, and commits by the user's GitHub no-reply
      address ([sync-design.md](sync-design.md#signing-in-with-github)).
      GitLab later, the same way (`read_user`).
- [x] **Orphaned pages.** The app shows pages whose parent was deleted at the
      top level.
- [x] **Default location.** New and joined workspaces go in the app's local
      data folder unless the user picks one, and "Show in Finder" reveals it
      ([sync-design.md](sync-design.md#the-local-copy)).
- [x] **Renaming workspaces.** The name lives in `workspace.json` and syncs;
      folders and remotes keep theirs. Click the name in the sidebar to
      rename ([sync-design.md](sync-design.md#renaming)).
- [x] **Workspace list and moving.** Known workspaces in `settings.json`;
      clicking the workspace name opens a switcher (with Rename and "Add
      workspace…"), a missing folder shows "Locate…", the welcome screen
      lists recent workspaces, and "Move…" in the sync panel moves the
      folder ([sync-design.md](sync-design.md#the-workspace-list)).
- [x] **Folder remotes.** A bare repo, `<name>.docsync`, in any folder the
      user picks: usually somewhere in iCloud Drive, Dropbox or OneDrive, but a
      network drive or USB stick works the same. One ref per device,
      published without `git push`, and tested with a simulated cloud that
      copies files one at a time in random order
      ([sync-design.md](sync-design.md#cloud-folder-remotes)).
- [x] **Sync setup.** A workspace is kept in a folder or in a Git
      repository, shown as two blocks. New workspaces take one screen: a
      name, then "In a folder" ("Kept in On this computer [Change…]", where
      any folder gets a `.docsync` folder; one in Dropbox, OneDrive or
      iCloud Drive puts it on every device) or "In a Git repository"
      (GitHub or a URL). Joining lists the
      workspaces found on GitHub and in the installed cloud folders. The
      pages always live in the app's data folder, and "Change…" in the sync
      panel moves the workspace elsewhere, taking the whole history along
      ([sync-design.md](sync-design.md#setting-it-up)).
- [x] **Following a switch.** A device that moves sync somewhere else
      leaves a note in `workspace.json` and syncs it to the old place, and
      the other devices follow on their next sync once the new place holds
      the workspace. A device that can't reach it yet keeps syncing where
      it was and says where the workspace went
      ([sync-design.md](sync-design.md#following-a-move)).

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
- [x] **Editor: tables.** As in Notion: on the table under the pointer, a
      grip on the row and one on the column. Drag one to move the row or
      column, or click it for a menu to insert above, below, left or right,
      or delete; "+" bars add a row or column at the end. The header row
      stays first and keeps at least one row under it, so the Markdown is
      always a valid table.
- [x] **Links and search.** Clicking a link opens it (in the browser, or the
      page it points to); hovering shows it with copy and edit (text, address, remove).
      ⌘K searches page titles and text. The sidebar can
      be resized and hidden (⌘\\).
- [x] **Importer.** Front matter moves into `meta.json` before a page
      reaches the editor (on open, for pages written by other tools and
      agents). "Import…" under the page tree brings in Markdown files or a
      folder (an Obsidian vault, a Notion export): folders become pages, a
      `# Heading` on the first line becomes the title, links between the
      files (including `[[wikilinks]]`) point at the new pages, and linked
      images and files are copied into each page's `assets/`
      (`docsync::import`). Showing those images in the editor is still to
      come.
- [x] **App shell** (`apps/desktop`). Tauri 2 + React, calling `docsync`
      directly from the Rust side. Opens, creates or joins a workspace and sets
      the remote this device syncs with.
- [x] **Pages.** A page tree, a page view with the editor, and conflict blocks
      shown above the page with "keep this version".
- [ ] **Databases.** A database table view.
- [ ] **Conflict markers in the editor.** They show as labelled lines; a
      proper block with each version's device name would be clearer.
- [x] **Bundled Git.** The app ships with Git for macOS, Windows and Linux
      (GitHub Desktop's portable builds, fetched and checked at build time
      by `apps/desktop/scripts/fetch-git.mjs`), and uses an installed Git
      only when a build has none.

## 4. Ask an agent from a page

The smallest thing that tests the core claim of
[product-design.md](product-design.md): someone who has never heard of git
hands real work to an agent and approves the result. One person, one space,
Claude Code on this computer, no server.

The workspace is plain files in git, so the way to bring in AI is to be the
place the agents people already use (Claude Code, Codex) can work in, rather
than shipping our own agent.

- [ ] **MCP server.** Built on the same crate, with tools to search, read
      pages, create and update pages, query databases and list backlinks.
      Writes go through the same merge as the editor, so they never fight an
      open page. Commits made by agents are credited to the agent, so the
      history shows which changes came from AI.
- [ ] **Harness adapter: Claude Code.** Over stdio in the Rust backend,
      streaming messages, tool calls and permission requests
      ([agents-design.md](agents-design.md#harnesses-claude-code-and-codex)).
- [ ] **Drafts.** Each run works on a hidden branch in its own working
      copy, so nothing changes until it is applied, and applying merges with
      the rules a sync uses ([agents-design.md](agents-design.md#drafts)).
- [ ] **Sync changes.** A plain-text merge kind for code, and broader ignore
      rules with a size limit and a secrets check
      ([agents-design.md](agents-design.md#what-it-changes-in-the-sync-engine)).
- [ ] **Thread panel.** A panel beside the page to write to an agent about
      it. The run's steps stay folded away, and it ends with "Changes to
      review".
- [ ] **Review and apply.** The draft's changes shown as outcomes, never as
      file paths or diffs: the agent's summary, each page with its changes
      marked, the rows added. Apply, ask for changes (the agent continues on
      the same draft) or discard
      ([product-design.md](product-design.md#drafts-and-review)).
- [ ] **Page history and undo.** A timeline for each page: who or what
      changed it (person, device or agent) and when, with what changed and
      "restore this version". Undo for a draft that was applied.

## 5. Agents as files

An agent becomes something that lasts: a teammate defined by files in the
space, with instructions, rules and connections
([agents-design.md](agents-design.md)).

- [ ] **Agent format.** `agents/<id>/` with `agent.json`, skills, databases
      and an optional `ui/`; device-only state in `.docsync/`. Agents are
      entities in the sync engine, like pages and databases.
- [ ] **Rules.** What an agent does alone and what it asks first. The app
      enforces them: an action with side effects, such as sending an email,
      only happens when a person approves it.
- [ ] **Connections.** Outside services through MCP servers, with the scopes
      the agent may use. Credentials stay in the system keychain.
- [ ] **Agent profile.** A page per agent that says in plain words what it
      may do, with its recent activity, and "Agents" in the sidebar.
- [ ] **Harness adapter: Codex.** The second adapter, so the harness is a
      setting on the agent.
- [ ] **Standard views.** Approval queue, table, chart, metric tiles. They
      need the database table view from step 3.
- [ ] **Large files.** A pointer in git and the bytes in a file store,
      fetched when a file is opened, so video, audio and generated images
      stay out of the repo
      ([product-design.md](product-design.md#what-stays-out-of-git)).
- [ ] **First agent: email.** Triage, drafts and sending after approval.

## 6. Search and links

- [ ] **Local search.** A SQLite full-text index stored in `.docsync/`, which
      is never synced, to replace the plain scan ⌘K uses now. It covers
      every space on the device once there are several (step 7).
- [ ] **Links between pages.** Typing `[[` opens a menu of pages, filtered as
      you type, and inserts a normal Markdown link to the page's id
      (`[Title](../<id>/page.md)`, the format `links.ts` already reads), so
      links still work on GitHub, in other editors and for agents, and
      survive renames. "Create page …" when nothing matches.
- [ ] **Backlinks.** "Linked from N pages" at the bottom of each page, with
      the sentence around each link. A reverse link index next to the search
      index in `.docsync/`. Later: unlinked mentions (the title as plain text,
      with "link it"), and "update N links to the new title" after a rename.
- [ ] **CLI.** The same operations from the terminal and scripts, for
      developers and for the scripts in step 9.

## 7. Spaces, people and the inbox

The team joins. A company is several spaces, each a git repo with its own
list of people ([product-design.md](product-design.md#spaces)), and this
step still needs no service of our own. That shapes what is possible:
collaboration is asynchronous (changes arrive with the next sync), everyone
with access to a space sees all of it and its history (see
[sync-design.md](sync-design.md#sharing-with-other-people)), and identity is
trusted rather than verified, as in a shared folder.

- [ ] **Several spaces at once.** The app opens every space a person belongs
      to (today one workspace at a time), each with its own sync, and the
      sidebar lists them. Every space gets a stable id. On GitHub the
      company is an organization: the app lists the spaces a person can open
      there, and creates new ones in it.
- [ ] **A private space** for each person, synced only between their own
      devices, for personal notes and personal agents.
- [ ] **Access across spaces.** Links that carry the space's id as well as
      the page's, views that show a table from another space, and a reading
      list per agent, so one space uses what another makes without copies
      ([product-design.md](product-design.md#access-across-spaces)).
- [ ] **People.** `people/<person-id>/profile.json` (name, colour, optional
      email) and a profile picture resized to a small size before it is
      saved, since git keeps every version. The id is random, not an email.
      Each device belongs to a person, and commits record the person as well
      as the device. Agents get a profile too, so their edits and comments
      show up like anyone else's. Device-only settings (theme, window,
      sidebar) stay out of the workspace.
- [ ] **Sharing.** A "Share" button that invites people to the space's
      GitHub repo, and accepting the invitation on their device. View-only
      access needs the repo to be in an organization.
- [ ] **Profiles from GitHub or GitLab.** On first sign-in, fill in the
      profile from the account (`GET /user` on GitHub, `GET /api/v4/user` on
      GitLab): name and picture, with the picture downloaded and resized like
      any other rather than linked. The workspace profile stays the source of
      truth, since not everyone signs in; later, "update from GitHub" instead
      of silently overwriting. The profile records linked accounts by their
      numeric id (`"accounts": [{"provider": "github", "id": …, "login": …}]`),
      since usernames can change, so an invited username is matched to its
      profile when that person joins. The repo's collaborator list shows who
      has access but has not joined yet, and who was removed. Signing in
      does not verify names in the history: the host knows who pushed, not
      who wrote each commit.
- [ ] **Threads on pages.** On a page or on a selection, with replies,
      resolve and reactions, and with agents taking part like anyone else.
      Stored outside the page's Markdown so pages stay clean for other tools
      and agents, one file per message so two people writing at once never
      conflict. A thread on a selection remembers its block and the quoted
      text and finds them again after edits; if the text is gone, the thread
      says so instead of disappearing.
- [ ] **Mentions.** `@` opens a menu of people and agents (also pages and
      dates) and inserts a link to the person's id. A "person" column type
      for databases, for assigning rows.
- [ ] **Tasks.** A thread with an owner, who is a person or an agent, and a
      status. "Tasks" in the sidebar shows them as a list or a board.
- [ ] **Inbox.** Changes waiting for your approval, agents waiting for an
      answer, mentions, replies and changes to pages you follow, worked out
      on each device after a sync, since there is no server to send them.
      They only arrive when the app syncs and nothing reaches a closed app;
      scripts (step 9) can forward them to Slack or email.
- [ ] **What changed.** "Changed since you last looked" on pages, and a
      list of recent changes across a space, including what agents did
      without asking.
- [ ] **Recent activity on a page.** "Anna edited this 2 minutes ago" when
      you open a page someone else just changed, and faster syncing while a
      page that others edit is open, so two people editing the same page at
      once is rare and visible rather than a surprise conflict.
- [ ] **Code from other people.** An agent's skills, scripts and UI written
      by someone else, or on another device, don't run on this device until
      they are approved here, with approval tied to their contents.
- [ ] **Clear expectations about access.** The app says plainly that a
      space is shared as a whole, that anyone removed keeps the copy they
      already have, and that names and comments stay in the history. Private
      pages belong in the private space. Read-only members come from the
      sync target (read access on GitHub, a view-only folder share), and
      can't comment, since a comment is a write.
- [ ] **Internal release.** Code signing and notarization for macOS,
      automatic updates (Git already ships with the app), so teammates
      can install it.

## 8. Channels and direct messages

The first step that needs a server: a small relay
([product-design.md](product-design.md#servers)).

- [ ] **Prototype messages in git first.** This is the riskiest new piece:
      the volume, a sender going offline before syncing, and deletion, since
      history keeps everything. An append-only log per device per day keeps
      one writer per file ([product-design.md](product-design.md#chat)).
- [ ] **Relay.** One small always-on program that passes messages, presence
      and "sync now" between running apps. It stores nothing and has no
      accounts: a key kept in each space's repo lets anyone who can read
      that repo join its channel. The app works without it.
- [ ] **Channels, threads, direct messages.** Deliberately small. A channel
      is a list of threads in a space.
- [ ] **Notifications** for mentions and replies while the app is running.
- [ ] **Editing a page together.** Who is viewing a page, live cursors and
      editing a page in real time. Git cannot do this, so it runs over the
      relay, with git still the record. Moved up from "Later": in a team two
      people will type in one page at once, and conflict blocks aren't
      acceptable there.

## 9. Triggers and runners

Agents start by themselves, which needs somewhere to run while laptops are
closed.

- [ ] **Events.** The app emits an event after a change is saved (not per
      keystroke): page created, changed, moved or deleted; database row
      created, changed or deleted; sync finished (with what came in from
      other devices); conflict found or resolved; site published. Each event
      says where the change came from: this device, another device, or an
      agent.
- [ ] **Triggers.** An agent starts on a schedule, on an event (a message in
      a channel, a row added to a table) or when it is mentioned. One chosen
      machine runs each trigger, so an action doesn't happen once per
      device.
- [ ] **Runner.** The app's core without a window, on an always-on machine
      the team owns, with agent credentials the company owns rather than
      someone's personal subscription.
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

## 10. Public release

Until here the app is for our own team. Opening it up, with a paid
subscription, adds what people without GitHub accounts need
([product-design.md](product-design.md#servers)).

- [ ] **Hosted sync.** Git over HTTPS with email accounts, as one more sync
      target ([sync-design.md](sync-design.md#sync-targets)): a thin server
      of our own, or Forgejo behind our sign-in.
- [ ] **Accounts and subscription.** Email sign-in, companies and billing.
- [ ] **Hosted runner.** Agents run for a team, with customers bringing
      their own agent login at first.
- [ ] **Phone and web.** Chat and approvals, as a thin client.
- [ ] Landing page
- [ ] Product name and domain

## Alongside

Not on the path above. Picked up when something needs them or there is room.

### Developer essentials

- [ ] **Diagrams and math.** Mermaid code blocks drawn as diagrams, and math
      (`$…$` and `$$…$$`), both stored as plain Markdown.
- [ ] **Keyboard first.** Every action reachable from the keyboard, with a
      command menu, and an optional vim mode in the editor.
- [ ] **Open elsewhere.** "Open in terminal" and "Open in editor" for the
      workspace folder. (Instead of a terminal built into the app: developers
      already have one they like.)
- [ ] **Developer mode.** Files, git and an agent's raw steps, for whoever
      builds the agents. Off by default.

### History

Git already has every version. Page history and undo are in step 4, "What
changed" in step 7.

- [ ] **Clearing history.** Start the history again from the current pages:
      one commit with no parents, and a "history was reset" marker that other
      devices follow by adopting the new start and replaying only their
      unsynced edits as file changes (a merge would bring the old history
      back, since unrelated histories merge). The remote has to forget too:
      delete the old objects from a folder remote (its cloud service may still
      keep them in its trash or version history for weeks), and on GitHub
      recreate the repository, since a force-push leaves old commits
      reachable for a while. So this is housekeeping, not a promise that
      text is gone everywhere; for that, start a fresh workspace from the
      current pages and delete the old remote and copies.
- [ ] **Compacting folder remotes.** Git's own cleanup is off in a folder
      remote, because repacking while another device is mid-upload could lose
      data, so it gains a small pack per sync. Compact it once every device's
      latest work is fully present.

### Publish to a static site

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
- **AI-built blocks.** Now part of agents: an agent's optional `ui/`, which
  runs in a sandboxed iframe and reaches data only through a narrow API
  ([agents-design.md](agents-design.md)).
- **Writing commands.** "Improve writing" and similar, using the user's own
  agent or API key, with the result shown as a suggested change to accept.
- **Signed commits.** Signing with each person's key, so names in the
  history can be verified.
- **Sharing cloud folders from the app.** The Share button for a cloud
  folder workspace: macOS's share window for iCloud Drive, and for Dropbox
  and OneDrive (which have no such API) showing the folder with a hint to
  share it there. Until then people share the `.docsync` folder from the
  cloud service themselves, and joining already finds it.
- **Docs in code repos.** Edit a code repo's `docs/` folder or README in the
  app, working on a branch and opening a pull request instead of syncing to
  `main`.
