# Agents: doing work in a space

**Status: being designed.** Nothing here is built yet. This records the
format of an agent, what has been decided so far, and the questions still
open, so the discussion can continue later. The direction it belongs to is
in [product-design.md](product-design.md).

Until 2026-11-25 this document called the bundle it describes a "task". It
is now an **agent**, and a **task** is a piece of work owned by a person or
an agent ([product-design.md](product-design.md#the-model)).

## The idea

Pages and databases stay central, as in Notion, but agents also do actual
work: handle email, analyse a YouTube channel, show the state of the
business' finances, track a team's KPIs.

The unit for that is an **agent**: a teammate with a profile, defined by
files in a space, that bundles

- instructions: skills, and links to the ordinary pages it should follow;
- rules: what it does alone and what it asks first;
- connections to outside services;
- a UI, mostly built from standard components the app supplies;
- a folder with the code, settings and assets it needs.

A harness (the user's own Claude Code or Codex) runs the agent and develops
it further.

The app provides the structure, so agents fit into the interface: a
profile, a block on a page, a quick view of the skills that were developed,
and a lower-level view of the agent's files.

## Decided so far

- **The app is always responsible for syncing.** Agent folders sync like
  pages, invisibly. Nobody using the app deals with branches, pull requests
  or merges. (A run does use a hidden branch underneath, see
  [Drafts](#drafts).) Real software projects stay in their own repos,
  outside the spaces (see "Docs in code repos" in the
  [roadmap](roadmap.md#later)).
- **An agent lives in one space,** the one the user puts it in, and
  everyone with access to that space sees it, its files and its synced data
  (a space is the unit of sharing, see
  [product-design.md](product-design.md#spaces)). A personal agent lives in
  the person's private space.
- **Credentials are never synced.** They stay in the system keychain, per
  person and device. An agent that needs credentials the user doesn't have
  shows that it can't run for them and offers to connect; everything else
  about the agent still works.
- **Nothing is published or copied between spaces.** An agent writes only
  to its own space. Reading another space is wanted since 2026-11-25
  (marketing needs what video production makes), and the proposal for it is
  a reading list per agent
  ([product-design.md](product-design.md#access-across-spaces)). Before
  that, an agent couldn't read another space either.
- **No scheduled triggers yet.** Every run starts from a person: a button
  in the agent's block or a message that mentions it. Schedules come with
  runners ([roadmap step 9](roadmap.md#9-triggers-and-runners)).
- **Agents run on the user's own Claude Code or Codex**, connected the way
  T3 Code does it, not an agent we ship. Which harness runs an agent is a
  setting on it, so others can follow.

## Example agents

Four real agents, used to work out the format. Each stresses something
different.

| Agent | What it does | What it adds to the format |
|---|---|---|
| **Email** | Triages the inbox, drafts replies, sends them after approval | Actions with side effects, approval, sending exactly once, mail that must not land in git |
| **YouTube** | Channel stats and recommendations for what to do next | Time series, charts, the agent producing structured rows (recommendations with a status), not just prose |
| **Moneybird** | An overview of the business' finances | Read-only access enforced by the app, sensitive data |
| **Team KPIs** | A dashboard of the team's KPIs, updated by the team | Several people writing at once, values coming from other agents |

None of the four needs a custom UI. Between them they need an approval queue,
a table or board, a chart, metric tiles, a recommendation list and a report.
So standard components come first, and a custom `ui/` is the exception.

The first one to build is **email**: it forces connections, an action that
needs approval, device-only data and a standard view early. The others mostly
reuse that.

## The format (draft)

```text
agents/<agent-id>/
  agent.json                     manifest
  skills/<name>/SKILL.md         agent instructions
  ui/                            optional custom UI: HTML/JS in a sandboxed iframe
  scripts/
  assets/
  databases/<db>/schema.json     the agent's own data, one file per row
  databases/<db>/rows/<row>.json
```

Device-only state (caches, run logs, temp files, downloaded mail) goes in
`.docsync/`, which never syncs.

The manifest for the email agent, as a sketch:

```json
{
  "actions": {
    "send": {"approval": "required", "connection": "mail"}
  },
  "changes": "apply",
  "connections": {
    "mail": {"kind": "mcp", "scopes": ["read", "draft", "send"], "server": "gmail"}
  },
  "databases": {
    "drafts": {"sync": "space"},
    "inbox": {"sync": "device"}
  },
  "description": "Triages the inbox and drafts replies",
  "harness": "claude-code",
  "instructions": ["../../pages/<page-id>/page.md"],
  "name": "Email",
  "views": [
    {"database": "drafts", "filter": {"status": "draft"}, "type": "approval-queue"},
    {"database": "inbox", "type": "table"}
  ]
}
```

What the parts are for:

| Part | Purpose |
|---|---|
| `name`, `description` | The agent's profile, with a picture in `assets/` |
| `harness` | Which harness runs it: `claude-code` or `codex` |
| `instructions` | Ordinary pages the agent must follow, as links. A handbook page on refunds is then documentation for people and an instruction for the agent at once |
| skills | `SKILL.md` files in the open Agent Skills format, so they also work in Claude Code and Codex outside the app |
| `connections` | External services and the scopes the agent may use. MCP servers are the likely mechanism. Credentials live in the keychain, never here |
| `databases` | The agent's data, each with a sync setting: `space` (synced) or `device` (this device only) |
| `actions` | Anything with side effects, with whether it needs approval |
| `changes` | Whether the agent's changes to the space apply themselves (`apply`) or wait for a person (`review`), see [Drafts](#drafts) |
| `reads` | Other spaces the agent may read, by id. Not used by this one |
| `views` | Standard components bound to the agent's databases; `ui/` for anything custom |

`harness`, `instructions`, `changes` and `reads` were added on 2026-11-25
with the profile, the rules and the reading list, and are the least settled.

### Three kinds of content

This split decides whether sync stays invisible:

| | What | Synced? | How it merges |
|---|---|---|---|
| **Definition** | manifest, skills, UI, scripts, settings, template assets | Yes | Line merge for text; agent edits reviewable |
| **Data** | what the agent produces and works on: drafts, recommendations, KPIs | Yes, as database rows | Field by field, one file per row |
| **Runtime** | caches, run logs, temp files, downloaded inputs | No, in `.docsync/` | Never merged |

Without it, runs write logs and output into the agent's folder, which means
churn and conflicts on every run. Data that can be fetched again (the inbox,
raw YouTube stats, Moneybird figures) is runtime, not data.

### Where an agent is shown

- **A profile** that says in plain words what the agent may do: its
  instructions, connections, what it does alone, what it asks first, and
  its recent activity ([product-design.md](product-design.md#the-window)).
- **In threads.** An agent can be mentioned in any thread and written to
  directly, like a person.
- **A block on a page** refers to an agent by id plus a little per-block
  configuration; it doesn't contain the agent. One agent can appear on
  several pages, can be duplicated into a variant, and the skills view
  lists agents rather than blocks.

## Harnesses: Claude Code and Codex

The app runs the user's installed `claude` or `codex` with their own login
and subscription, and shows the session in the thread it was started from.

- **One adapter per tool, over stdio, in the Rust backend.** Codex has
  `codex app-server` (JSON-RPC). Claude Code has `--input-format stream-json
  --output-format stream-json`, which the Agent SDK is built on, so no Node
  runtime is needed. Both stream messages, tool calls and permission
  requests, which the thread shows as a conversation with the steps folded
  away. The exact protocols need checking against current versions.
- **The working directory is a draft of the agent's space** (below), with
  the agent's own folder in it. The harness writes skills, scripts and
  assets there. Access to pages and databases goes through the app's own
  MCP server ([roadmap step 4](roadmap.md#4-ask-an-agent-from-a-page)),
  passed to the session, along with the agent's declared actions. Spaces on
  its reading list are there to read only.
- **The app enforces approval, not the harness.** The MCP `send` tool never
  sends: it creates a draft and returns "awaiting approval". Only the
  approve button sends. Approval then holds whatever the harness does and
  whichever tool it is. The harness's own permission modes (Claude Code's
  permission modes, Codex's sandbox) cover files and shell commands in the
  folder.

## Drafts

Each run works in a **draft**: a hidden branch of the space with its own
working copy on this device (a Git worktree), apart from the files people
are editing.

- **Nothing changes for anyone else until the draft is applied.** The space
  keeps syncing and people keep editing meanwhile, and other devices never
  see a half-finished run.
- **Several agents can run at once,** each in its own draft, and a run that
  went wrong is discarded without a trace.
- **A run ends with changes to review** in its thread
  ([product-design.md](product-design.md#drafts-and-review)). A reply that
  asks for changes continues the same draft.
- **Applying is a merge with the sync engine's rules**
  ([sync-design.md](sync-design.md#conflict-rules)), so pages that changed
  while the agent worked merge the way two devices' edits do. It shows in
  History as one change credited to the agent, and Undo reverts it.
- **The agent's rules decide who applies.** With `"changes": "apply"` a
  draft applies itself when the run ends; with `"review"` it waits for a
  person. Actions with side effects have their own approval either way.

This replaces the earlier plan of "one session is one commit", with
auto-commit held back for the agent's folder while a session runs. That
couldn't isolate a run that edits pages and tables as well as its own
folder, and couldn't let two agents run at once.

## What it changes in the sync engine

The engine's core doesn't care what's in the files: the sync loop, the lock,
merging in the object database, crash safety, folder remotes and auth all
work as they are. What assumes notes:

- **Code merges like an image.** `layout::file_kind` knows Markdown, JSON
  and "other". A script is "other": edits to different lines on two devices
  become a whole-file pick instead of a clean line merge, and the conflict
  copy (`deploy.conflict-laptop-ab12.sh`) keeps the code extension, so build
  tools and test runners pick it up. Add a plain-text kind: line merge; on
  overlapping edits, newest at the original path and the other in a copy
  that doesn't end in a code extension (`deploy.sh.conflict-laptop-ab12`).
  Never conflict markers in code.
- **Everything in the folder gets committed.** `commit_local` runs
  `git add -A`, and the default `.gitignore` only knows `.docsync/`. Code
  brings `node_modules/`, `.venv/`, `target/` and build output, and a `.env`
  would be pushed silently. Needed: a broader default ignore list, a size
  limit before committing, and a secrets check that refuses to commit and
  says why (one of the few times a visible warning is right).
- **The file watcher syncs on every change.** An `npm install` would cause a
  storm of syncs. The watcher should use the same ignore rules as commits.
- **Agents are entities.** `layout::dir_entity` only knows `pages/` and
  `databases/`. With `agents/` added, an agent deleted on one device and
  edited on another comes back whole, not as a single stray file.
- **Drafts.** Creating a working copy on a hidden branch, applying it
  through the same `merge-tree` path a sync uses, and discarding it. The
  sync loop leaves draft branches alone, and the file watcher and the
  search index ignore draft working copies.
- **Tests.** The simulation should generate code files and agent folders
  too, and apply drafts while devices edit and sync.

## Open issues

- **Personal versus shared agents.** Mostly settled by spaces: a personal
  agent lives in the person's private space, which only their devices sync
  ([product-design.md](product-design.md#spaces)). Git has no per-file
  permissions, so an agent can only be private by living outside the shared
  repo, not by being hidden in the UI. Still open: whether a private agent
  can appear on a shared page, visible only to its owner, and a shared
  definition with personal data (a team email assistant where everyone
  connects their own mailbox).
- **Values from one agent in another.** The team KPI dashboard wants
  revenue from Moneybird and subscribers from YouTube. A view can show
  another agent's table, from another space too if the viewer can read it
  ([product-design.md](product-design.md#access-across-spaces)). Whether an
  agent may write rows into another agent's database (declared in the
  manifest, approved by the user) isn't settled.
- **How fine the rules are.** `changes` is one switch for the whole space.
  Real rules are finer: an agent's own tables apply themselves while pages
  wait, or a refund over €50 asks first. How they're written down, and how
  the profile says them in plain words, isn't settled.
- **Files or tools in a draft.** Nothing else writes a draft's files, so
  the harness could edit pages there as plain files, which is what
  harnesses are best at. But new pages and rows need ids and the exact JSON
  layout, which the MCP tools guarantee. Probably both, with a draft
  checked before it can be applied.
- **Reviews on another device.** A draft someone else has to approve must
  reach their device, so its branch has to sync too. With one person on
  one device it stays local.
- **Sending exactly once.** Sync is asynchronous, so an approved draft
  reaches every device. Without schedules, sending happens only on the
  device where the user presses approve. With schedules, an action needs one
  device that runs it, and must survive a crash: mark the draft "sending"
  with its Message-ID first, and check the Sent folder for that ID before
  retrying.
- **Scheduled triggers.** On the roadmap, not now
  ([step 9](roadmap.md#9-triggers-and-runners)). They need something that
  runs while the app is closed (a runner on an always-on machine, later a
  hosted one) and a rule for which machine runs them.
- **Team credentials.** A schedule on a runner needs agent credentials and
  connections the company owns, not one person's subscription and
  keychain. Where they're kept isn't settled.
- **Running synced code.** Skills, scripts and UI written on another device
  or by another person are code that runs. They must not run until approved
  on this device, with approval tied to their contents
  ([roadmap step 7](roadmap.md#7-spaces-people-and-the-inbox)). Plus
  per-agent permissions from the manifest: which databases, network access,
  which connections.
- **Sandboxing.** Most people can't judge a shell command, so a run should
  be confined by rules set up front rather than ask. Whether the harness's
  own sandbox is enough isn't settled.
- **Synced data is visible to everyone in the space.** An agent in a shared
  space that syncs sensitive data (financial figures, email drafts) shows
  it to everyone with access, in the history too. For now that's the user's
  responsibility; the app should at least say so when an agent with `space`
  databases sits in a shared space.
- **Where the agent's output goes.** Rows in the agent's databases, pages,
  or both. Recommendations as rows with a status make them something to work
  through; a report as a page makes it something to read and share.
- **Standard components.** Which ones, how they bind to databases, and how a
  custom `ui/` reaches data (a narrow API from the sandboxed iframe).
- **Large and binary files** stay out of Git: a pointer in the repo and the
  bytes in a file store
  ([product-design.md](product-design.md#what-stays-out-of-git)). Not
  designed yet.
