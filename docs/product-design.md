# Product design: a workspace for a company's people and agents

**Status: being designed.** Pages and sync are built
([sync-design.md](sync-design.md)); nothing else here is. This records the
direction, what has been decided, the design proposed to go with it, and the
questions still open, so the discussion can continue later.

## The idea

The app grows from a note-taking app into the place a company's team works,
with agents doing much of the work. It merges three things:

- **Notion:** pages and databases, to organize what the company knows.
- **Slack or Teams:** channels and messages, to talk in text.
- **T3 Code:** agents that work in a Git repository, each in its own copy,
  with the result reviewed before it lands.

T3 Code works well for developers, but most people have no idea how to deal
with pull requests and merges, and it has no place for notes or for a team's
conversation. The app keeps what makes that way of working effective
(isolation, review, history) and hides the machinery.

Everything lives in Git repositories the company owns, except large files
such as video and audio. Agents come from the harnesses people already use
(Claude Code, Codex) and work in those repositories on the company's tasks
and projects. Most of this is invisible to the people using it, who are no
longer only developers.

## Decided so far

Decided on 2026-11-25:

- **Everything in Git, except large files.** Pages, tables, messages, tasks
  and agent definitions are plain files in Git. Video, audio and other large
  files stay out ([What stays out of Git](#what-stays-out-of-git)).
- **The machinery stays invisible.** Nobody using the app deals with
  commits, branches, pull requests or merges, and the interface doesn't use
  those words.
- **A company is several repositories,** called spaces, each with its own
  list of people. What one space needs from another must not turn into
  copies everywhere ([Spaces](#spaces)).
- **Agent and task.** The bundle of instructions, rules, connections and
  files that used to be called a task is an **agent**
  ([agents-design.md](agents-design.md)). A **task** is a piece of work
  owned by a person or an agent.
- **No server for now.** The next steps are built without one, and a server
  is added later ([Servers](#servers)).
- **Internal first, and cheap.** The first version is for our own team. It
  may open to the public later, with a paid subscription.

Decided earlier and still standing: the app always owns syncing
([sync-design.md](sync-design.md)), credentials are never synced, and agents
run on the user's own Claude Code or Codex rather than an agent we ship
([agents-design.md](agents-design.md#decided-so-far)).

The rest of this document is the design proposed alongside those decisions.
It hasn't been confirmed point by point.

## The model

Three nouns:

- **Pages:** what the company knows, as pages and tables. As today.
- **Threads:** where people and agents talk. A channel is a list of
  threads, a comment on a page is a thread, and a task is a thread with an
  owner and a status. Mention an agent in a thread and it does the work,
  then posts its changes for review in that same thread.
- **Agents:** teammates with a profile, defined by files in a space: their
  instructions (skills, and ordinary pages they should follow), their
  connections, what they do alone and what they ask first
  ([agents-design.md](agents-design.md)). Which harness runs an agent is a
  setting on it; the app enforces the rules, not the harness.

The thread is what the three products share. In Slack it's a conversation,
in T3 Code it's a conversation with an agent that ends in a pull request,
and in Notion it's the comments on a page. One kind of thread, which people
and agents both take part in and which can end in changes to review, covers
all three. Chat, comments and agent runs are then views of the same thing
rather than three products side by side.

## The words people see

| Git | What people see |
|---|---|
| Repository | A space (Marketing, Finance, Private) |
| Commit, push, pull | Nothing, just "Synced" |
| Branch and worktree | Draft |
| Pull request | Changes to review |
| Merge | Apply |
| Revert | Undo |
| Log | History |

A developer mode can show files, Git and an agent's raw steps, for whoever
builds the agents. It's off by default.

## Spaces

A **space** is one Git repository: what [sync-design.md](sync-design.md) and
the code call a workspace. A **company** is a set of spaces. Git hosts grant
access per repository, so a space is also a list of who may see it.

- **A space is an access list, not a department.** If the same people may
  see video production and marketing, those are two sections of one space.
  A separate space is only for a different list of people: Finance, or
  Video production if freelance editors work in it and shouldn't see the
  rest.
- **Everyone has a private space,** synced only between their own devices,
  for personal notes and personal agents.
- **On GitHub the company is an organization,** and its spaces are the
  organization's repositories that carry the `sawmill-workspace` topic.
  The app lists the ones a person can open; the rest are invisible to them.
  A free organization allows unlimited private repositories and
  collaborators.

### Access across spaces

Different parts of a company need each other's work: marketing needs the
scripts and thumbnails that video production makes. Nothing is copied for
that. Each thing lives in one space and other spaces refer to it, in three
layers:

1. **Fewer spaces.** Most of the need disappears when sections that the
   same people may see share a space.
2. **People belong to several spaces.** Marketing gets access to Video
   production, and each person's app holds every space they belong to, so
   search covers all of them. Marketing's pages then refer to things
   instead of holding them:
   - A **link** stores the space's id and the page's id, so it always opens
     the current version. Someone without access sees where the page lives,
     not its content.
   - A **view** shows a table from another space inside a page, filtered.
     The rows stay where they are.
   - **Files** such as thumbnails are linked the same way, and the bytes
     are stored once.
3. **Agents have a home and a reading list.** An agent's drafts land in its
   home space, and it can be allowed to read others. It runs with the
   access of whoever started it, so it never reads more than that person
   can.

The example, set up this way:

| | Video production | Marketing |
|---|---|---|
| Holds | A Videos table, the scripts, the thumbnails its agents generate | A Social posts table and campaign pages |
| People | The video team and freelance editors; Marketing can open it | The marketing team |
| Agents | Script and thumbnail agents | A Social agent that reads Video production |

Marketing's week page shows a view of the videos about to publish. The
Social agent reads a video's script and thumbnails in Video production, and
drafts posts in Marketing that link to the thumbnail.

Rules that go with it:

- **Part of a space.** If Marketing may see only part of Video production,
  that part moves to a space both can read. It is a move, not a copy.
- **Leaving a restricted space.** An agent that reads a restricted space
  and writes to a wider one always needs review, so a person approves what
  leaves.
- **Records.** A published post pins the version of the thumbnail it went
  out with. That is a reference to a version, still not a copy.

Limits:

- **View-only means no comments.** A comment is a write to the repository.
  For colleagues, edit access with history and undo is the simpler choice;
  view-only is for outsiders.
- **View-only needs a GitHub organization.** On a personal account every
  collaborator can also write.
- **Not Git submodules or mirrored folders.** Submodules don't change who
  can read what, and mirrors are the copies this avoids.

What this adds to the build: the app opens several spaces at once (today
one), every space gets a stable id, and links, views and agent runs carry
that id ([roadmap step 7](roadmap.md#7-spaces-people-and-the-inbox)).

## Drafts and review

An agent never works in the files people are editing. Each run gets a
**draft**: its own copy of the space, on a hidden branch
([agents-design.md](agents-design.md#drafts)).

- **Nothing changes for anyone else until the draft is applied.** Several
  agents can work at once, and a bad run is discarded without a trace.
- **A run ends with changes to review,** in the thread it was started from.
  Review shows outcomes: the agent's own summary first, then each page with
  its changes marked, the rows added to a table, the emails that will go
  out. Never file paths or diffs.
- **Three answers.** Ask for changes is a reply in the thread, and the
  agent continues on the same draft. Apply makes the changes real, merged
  with the same rules as a sync. Discard drops them. An applied change can
  be undone from History.
- **Rules decide who applies.** Each agent's rules say what it does alone
  and what it asks first. A draft that falls under "alone" applies itself
  and is listed under what agents did without you. Anything with an effect
  outside the space, such as sending an email, happens only on approval,
  and the app enforces that
  ([agents-design.md](agents-design.md#harnesses-claude-code-and-codex)).
- **Nobody judges a shell command.** Most people can't answer "allow this
  command?". Agents run sandboxed under rules set up front, and ask only
  about effects outside the space.

## The window

```text
+---------------+----------------------------------+-------------------+
| Acme        v | # marketing                      | Review            |
| Search or ask |                                  |                   |
|               | Anna    The launch moved to      | Q1 launch plan    |
| Inbox       3 |         12 March. @Writer can    |   5 March         |
| Tasks         |         you update the plan?     |   -> 12 March     |
| Agents        |                                  |                   |
|               | Writer  Done. I moved the dates  | Newsletter    new |
| SPACES        |         and drafted the          |                   |
| v Company     |         newsletter.              | Content calendar  |
|   # general   |         [Changes to review]      |   + 3 rows        |
|   Handbook    |                                  |                   |
| v Marketing   |                                  |                   |
|   # marketing |                                  |                   |
|   Q1 plan     |                                  | [Apply]           |
| > Finance     |                                  | [Ask for changes] |
| > Private     | Message #marketing               | [Discard]         |
| DIRECT        |                                  |                   |
|   Anna        |                                  |                   |
|   Writer      |                                  |                   |
| Synced        |                                  |                   |
+---------------+----------------------------------+-------------------+
```

- **Sidebar.** Search, which also takes a question, then Inbox, Tasks and
  Agents. Below them the spaces, each with its channels and its page tree,
  then direct conversations with people and agents. The sync status stays
  where it is, and stays calm.
- **Main area.** One thing at a time: a page, a channel, a task, a board, an
  agent's profile.
- **Side panel.** The thread that belongs to what's in the main area, or
  the review of a draft.
- **One message box everywhere,** with `@` for a person or an agent and
  `[[` for a page. Work starts by writing to someone.
- **Inbox is home.** Changes waiting for your approval, agents waiting for
  an answer, mentions and replies, and what agents did without you. Where
  agents do the routine work, approving and answering is most of what
  people do, so this is the screen to get right.
- **An agent's profile** says in plain words what it may do: its
  instructions, connections, what it does alone, what it asks first, when
  it starts and where it runs, with its recent activity.

## Chat

Channels belong to a space, and there are direct conversations between
people and with agents. Chat stays deliberately small: channels, threads,
direct messages and mentions. The value is in threads that do work, not in
matching Slack.

- **Git is the record.** Messages are files in the space, so an agent can
  read the discussion behind a request, and they're owned, searched and
  backed up like everything else. Proposed: an append-only log per device
  per day, so every file has one writer and messages never conflict, the
  rule folder remotes already follow
  ([sync-design.md](sync-design.md#cloud-folder-remotes)).
- **Delivery needs a relay.** GitHub recommends at most
  [6 pushes a minute per repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits),
  so a message can't be a push. Messages travel through the relay
  ([Servers](#servers)) and the existing sync writes them to Git in
  batches.
- **Before the relay exists,** threads on pages and tasks work with
  ordinary sync: a reply arrives with the next sync. That is enough for
  work with agents, not for chat.

## Servers

Decided: none for now. There are three separate jobs, and each arrives at
its own time:

| Job | What it does | When |
|---|---|---|
| Git hosting | Stores the repositories and decides who can open each | GitHub, built. Our own hosting with email accounts comes with a public release |
| Relay | Passes messages, presence and "sync now" between running apps | With chat |
| Runner | An always-on machine where agents run on a schedule | With triggers |

**The relay** is one small always-on program. It stays optional: without it
the app falls back to timed sync, and Git remains the only store, so losing
the relay loses nothing. It stores nothing and has no accounts: a key kept
in each space's repository lets anyone who can read that repository join
its channel and decrypt it.

**Hosted Git** is only needed for people without GitHub accounts. When the
app goes public, the relay's program gains email accounts, billing and Git
over HTTPS (a thin server of our own, or Forgejo behind our sign-in). The
app doesn't change, since it already syncs with any Git remote. GitHub's
guidance on pushes also means GitHub only stretches to a small team.

Rough costs, at prices of November 2026:

| Stage | What runs | Per month |
|---|---|---|
| Agent work from pages, spaces, inbox | GitHub, and each person's own Claude Code or Codex | Nothing |
| Internal chat | The relay on one small server | About €5 to €10 |
| Internal schedules | Agents on that server or an always-on computer at the office | No extra hosting, plus model usage |
| Public | Accounts, billing, hosted Git, relay, file storage, backups | Roughly €30 to €80 to start (an estimate) |

For large files, GitHub's large-file storage includes 10 GiB, then costs
$0.07 per GiB a month plus $0.0875 per GiB downloaded. A storage bucket is
about $7 to $15 per TB a month, which is cheaper for video.

The real costs are elsewhere:

- **Model usage** is billed by each person's Claude or Codex plan, not by a
  server of ours, and scheduled agents will cost more than all the hosting.
  A public version starts with customers bringing their own agent login, so
  their usage is never ours to pay.
- **Responsibility.** Holding other companies' data means owing them
  security, backups, uptime and GDPR paperwork. That is the main cost of
  going public.

## Where agents run

- **This computer,** with the person's own agent login, for work they
  start. This is all there is until triggers.
- **A team runner:** the app's core without a window, on an always-on
  machine the team owns, for schedules and triggers. It needs agent
  credentials the company owns rather than someone's personal subscription,
  and a place to keep shared connections.
- **A hosted runner:** the same, run for the team, with a public release.

## What stays out of Git

- **Large files** such as video and audio. Git keeps a small pointer and
  the bytes go in a file store, fetched when someone opens the file. Not
  designed yet. GitHub's large-file storage follows repository access with
  nothing extra to build; a storage bucket is cheaper for video.
- **Credentials.** In the system keychain, per person and device
  ([agents-design.md](agents-design.md#decided-so-far)).
- **Device-only state:** caches, run logs and the search index, in
  `.docsync/`.
- **Data that can be fetched again,** such as an inbox or raw statistics
  ([agents-design.md](agents-design.md#three-kinds-of-content)).

## Order

The build order is in the [roadmap](roadmap.md), steps 4 to 10. It starts
with asking an agent from a page: one person, one space, Claude Code on this
computer, no server. That is the smallest thing that tests the core claim,
that someone who has never heard of Git can hand real work to an agent and
approve the result. Our own team is the first customer, replacing its Slack
and Notion use one step at a time.

## Risks and open questions

- **Scope.** These are three mature product categories. Chat has to stay
  small, and every step has to be useful to our own team on its own.
- **Chat in Git** is the riskiest new piece: the volume, a sender going
  offline before their messages are synced, and deletion, since history
  keeps everything (which matters for privacy rules and for how long a
  company wants to keep messages). Prototype it before committing to it.
- **Two people in one page.** In a team tool two people will type in the
  same page at once, and conflict blocks won't be acceptable there. Live
  co-editing over the relay moves up from "Later"
  ([roadmap step 8](roadmap.md#8-channels-and-direct-messages)).
- **Direct messages and private channels** each need a space of their own,
  since access is per repository. That is cheap on our own hosting and
  awkward on GitHub.
- **A review someone else has to approve** must reach their device, so a
  draft's branch has to sync too. The first step, with one person on one
  device, doesn't need it.
- **How threads and tasks are stored:** the files, and how a thread stays
  attached to a selection in a page
  ([roadmap step 7](roadmap.md#7-spaces-people-and-the-inbox)).
- **Sandboxing.** How an agent's commands and file access are confined on a
  person's computer (the harness's own sandbox, or one of ours), so that
  nobody has to judge a command.
- **Team credentials.** Where a runner keeps the credentials and
  connections the company owns, since the keychain is per person and
  device.
