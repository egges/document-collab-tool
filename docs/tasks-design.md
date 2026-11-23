# Tasks: agents doing work in the workspace

**Status: being designed.** Nothing here is built yet. This records the
direction, what has been decided so far, and the questions still open, so the
discussion can continue later.

## The idea

The app moves from a note-taking app towards a productivity suite. Pages and
databases stay central, as in Notion, but agents also do actual work in it:
handle email, analyse a YouTube channel, show the state of the business'
finances, track a team's KPIs.

The unit for that is a **task**: a custom block on a page that bundles

- a UI, mostly built from standard components the app supplies;
- an agent session (the user's own Claude Code or Codex) to run it and to
  develop it further;
- skills: the agent's instructions for this task;
- a folder with the code, settings and assets the task needs.

The app provides the structure, so tasks fit into the interface: the block on
the page, a quick view of the skills that were developed, and a lower-level
view of the task's files.

## Decided so far

- **The app is always responsible for syncing.** Task folders sync like pages,
  invisibly. There is no developer flow with branches, pull requests and
  merges for workspace code. Real software projects stay in their own repos,
  outside the workspace (see "Docs in code repos" in the
  [roadmap](roadmap.md#later)).
- **Where a task lives is the user's choice.** A task is in whichever
  workspace the user puts it, and everyone with access to that workspace sees
  it, its files and its synced data (the workspace is the unit of sharing,
  see [sync-design.md](sync-design.md#sharing-with-other-people)). The app
  doesn't distinguish personal from shared tasks for now.
- **Credentials are never synced.** They stay in the system keychain, per
  person and device. A task that needs credentials the user doesn't have
  shows that it can't run for them and offers to connect; everything else
  about the task still works.
- **No publishing between workspaces.** A task reads and writes only its own
  workspace.
- **No scheduled triggers yet.** Every run starts from the user: a button in
  the block or a message in its chat. Schedules stay on the roadmap.
- **Agents are the user's own Claude Code or Codex**, connected the way T3
  Code does it, not an agent we ship.

## Example tasks

Four real tasks, used to work out the format. Each stresses something
different.

| Task | What it does | What it adds to the format |
|---|---|---|
| **Email** | Triages the inbox, drafts replies, sends them after approval | Actions with side effects, approval, sending exactly once, mail that must not land in git |
| **YouTube** | Channel stats and recommendations for what to do next | Time series, charts, the agent producing structured rows (recommendations with a status), not just prose |
| **Moneybird** | An overview of the business' finances | Read-only access enforced by the app, sensitive data |
| **Team KPIs** | A dashboard of the team's KPIs, updated by the team | Several people writing at once, values coming from other tasks |

None of the four needs a custom UI. Between them they need an approval queue,
a table or board, a chart, metric tiles, a recommendation list and a report.
So standard components come first, and a custom `ui/` is the exception.

The first one to build is **email**: it forces connections, an action that
needs approval, device-only data and a standard view early. The others mostly
reuse that.

## The format (draft)

```text
tasks/<task-id>/
  task.json                      manifest
  skills/<name>/SKILL.md         agent instructions
  ui/                            optional custom UI: HTML/JS in a sandboxed iframe
  scripts/
  assets/
  databases/<db>/schema.json     the task's own data, one file per row
  databases/<db>/rows/<row>.json
```

Device-only state (caches, run logs, temp files, downloaded mail) goes in
`.docsync/`, which never syncs.

The manifest for the email task, as a sketch:

```json
{
  "actions": {
    "send": {"approval": "required", "connection": "mail"}
  },
  "connections": {
    "mail": {"kind": "mcp", "scopes": ["read", "draft", "send"], "server": "gmail"}
  },
  "databases": {
    "drafts": {"sync": "workspace"},
    "inbox": {"sync": "device"}
  },
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
| `connections` | External services and the scopes the task may use. MCP servers are the likely mechanism. Credentials live in the keychain, never here |
| `databases` | The task's data, each with a sync setting: `workspace` (synced) or `device` (this device only) |
| `actions` | Anything with side effects, with whether it needs approval |
| `views` | Standard components bound to the task's databases; `ui/` for anything custom |
| skills | `SKILL.md` files in the open Agent Skills format, so they also work in Claude Code and Codex outside the app |

### Three kinds of content

This split decides whether sync stays invisible:

| | What | Synced? | How it merges |
|---|---|---|---|
| **Definition** | manifest, skills, UI, scripts, settings, template assets | Yes | Line merge for text; agent edits reviewable |
| **Data** | what the task produces and works on: drafts, recommendations, KPIs | Yes, as database rows | Field by field, one file per row |
| **Runtime** | caches, run logs, temp files, downloaded inputs | No, in `.docsync/` | Never merged |

Without it, agents write logs and output into the task folder, which means
churn and conflicts on every run. Data that can be fetched again (the inbox,
raw YouTube stats, Moneybird figures) is runtime, not data.

### Where a task is shown

A block on a page refers to a task by id plus a little per-block
configuration; it doesn't contain the task. One task can appear on several
pages, can be duplicated into a variant, and the skills view lists tasks
rather than blocks.

## Agents: Claude Code and Codex

The app runs the user's installed `claude` or `codex` with their own login
and subscription, and shows the session inside the task block.

- **One adapter per tool, over stdio, in the Rust backend.** Codex has
  `codex app-server` (JSON-RPC). Claude Code has `--input-format stream-json
  --output-format stream-json`, which the Agent SDK is built on, so no Node
  runtime is needed. Both stream messages, tool calls and permission
  requests, which the block shows as a chat with approval prompts. The exact
  protocols need checking against current versions.
- **The working directory is the task's folder.** The agent writes skills,
  scripts and assets there. Workspace access goes through the app's own MCP
  server ([roadmap step 4](roadmap.md#4-search-links-and-ai-agents)), passed
  to the session: read and write pages and databases, and the task's
  declared actions.
- **The app enforces approval, not the agent.** The MCP `send` tool never
  sends: it creates a draft and returns "awaiting approval". Only the approve
  button in the block sends. Approval then holds whatever the agent does and
  whichever tool it is. The agent's own permission modes (Claude Code's
  permission modes, Codex's sandbox) cover files and shell commands in the
  folder.
- **One session is one commit.** While a session runs, auto-commit is held
  back for that task's folder, so other devices never see a half-rewritten
  task. At the end, one commit credited to the agent ("Claude Code",
  "Codex"), reviewable like other agent edits
  ([roadmap step 6](roadmap.md#6-page-history-and-agent-review)). The rest of
  the workspace keeps syncing meanwhile.

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
- **Tasks are entities.** `layout::dir_entity` only knows `pages/` and
  `databases/`. With `tasks/` added, a task deleted on one device and edited
  on another comes back whole, not as a single stray file.
- **Holding back auto-commit** for one folder while an agent session runs.
- **Tests.** The simulation should generate code files and task folders too.

## Open issues

- **Personal versus shared tasks.** Set aside for now (see "Decided so far").
  The discussion so far: git has no per-file permissions, so a task can only
  be private by living outside the shared repo, not by being hidden in the
  UI. One option is a personal space per user (a second repo, synced only
  between that user's devices) whose tasks can appear on shared pages but
  are visible only to their owner, with the app choosing a default from
  whether the task needs credentials. Another is a shared definition with
  personal data (a team email assistant where everyone connects their own
  mailbox).
- **Values from one task in another.** The team KPI dashboard wants revenue
  from Moneybird and subscribers from YouTube. Publishing between workspaces
  was ruled out as too complicated. Within one workspace a task could be
  allowed to write rows into another task's database (declared in the
  manifest, approved by the user), but whether that's the right model isn't
  settled.
- **Sending exactly once.** Sync is asynchronous, so an approved draft
  reaches every device. Without schedules, sending happens only on the
  device where the user presses approve. With schedules, an action needs one
  device that runs it, and must survive a crash: mark the draft "sending"
  with its Message-ID first, and check the Sent folder for that ID before
  retrying.
- **Scheduled triggers.** On the roadmap, not now. They need something that
  runs while the app is closed (a small background process, later a hosted
  runner) and a rule for which device runs them.
- **Running synced code.** Skills, scripts and UI written on another device
  or by another person are code that runs. They must not run until approved
  on this device, with approval tied to their contents
  ([roadmap step 9](roadmap.md#9-hooks-and-automations)). Plus per-task
  permissions from the manifest: which databases, network access, which
  connections.
- **Synced data is visible to everyone in the workspace.** A task in a shared
  workspace that syncs sensitive data (financial figures, email drafts)
  shows it to everyone with access, in the history too. For now that's the
  user's responsibility; the app should at least say so when a task with
  `workspace` databases sits in a shared workspace.
- **Where the agent's output goes.** Rows in the task's databases, pages, or
  both. Recommendations as rows with a status make them something to work
  through; a report as a page makes it something to read and share.
- **Standard components.** Which ones, how they bind to databases, and how a
  custom `ui/` reaches data (a narrow API from the sandboxed iframe).
- **Large and binary files** produced by tasks make the "large attachments
  live in the repo" limitation more pressing (Git LFS or a blob store).
