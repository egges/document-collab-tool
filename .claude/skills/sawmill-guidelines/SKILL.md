---
name: sawmill-guidelines
description: Standard working guidelines for the Sawmill codebase. Use for any development work in this repo — writing or changing code, adding dependencies, restructuring files, and merging PRs.
---

# Sawmill working guidelines

Follow these whenever you work in this repo.

## Keep it simple

- Build the simplest thing that solves the actual problem. Don't overengineer.
- No speculative abstractions, config options, or extension points "for later".
- Prefer a few clear lines over a clever general solution. Three similar lines beat a premature helper.

## Prefer existing dependencies

- Before adding a dependency, check what's already in use:
  - Rust: `Cargo.toml` (workspace) and the crate's own `Cargo.toml` (`crates/*`, `apps/desktop/src-tauri`).
  - Frontend: `apps/desktop/package.json`, `packages/*/package.json`.
- Use an existing dependency (or the standard library) when it can do the job reasonably.
- Only add a new dependency when nothing in place fits, and say why in your summary.

## Check the structure as you go

- During any development work, ask whether the folder/module/file layout still fits the work.
- If a file is getting too big, mixes unrelated concerns, or new code doesn't have a natural home, restructure (split a module, move a file, add a folder) as part of the change.
- Keep restructuring proportional: move things because it makes the code clearer now, not for hypothetical future needs.

## Capture lessons as skills

- When you learn something during development that would make the work go better next time (a gotcha, a working command, a pattern that fits this codebase, a mistake to avoid), record it as a skill in `.claude/skills/`.
- Add it to an existing skill when it fits one (including this file); otherwise create a new skill with a focused name and a clear `description` saying when to use it.
- Keep entries short and concrete. Update or remove ones that turn out to be wrong.

## Merging PRs

- After merging a PR, switch the checkout back to `main` (and pull) **before** settling/organizing the thread.
