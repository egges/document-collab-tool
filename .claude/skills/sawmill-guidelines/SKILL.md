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

## Gotchas

- Tauri swallows files dropped on the window unless `dragDropEnabled` is
  `false` in the window config (both `tauri.conf.json` and
  `tauri.macos.conf.json`); it is, so HTML5 drops reach the editor. The
  catch: a file drop nobody cancels makes the webview open the file in
  place of the app. `refuseFileDrops` (windowChrome.ts) refuses those;
  anything that takes files must `preventDefault` its `dragover`.
- ProseMirror ignores DOM events that are already `defaultPrevented`. The
  editor's file drops (`react/FileDrop.tsx`) listen on the window in the
  capture phase, so they run first and the editor never also takes the drop
  as text.
- ProseMirror puts `img.ProseMirror-separator` elements next to inline
  nodes such as images: query `img[src]` in tests, and don't rely on
  `:only-child` in CSS.
- Run interactive-looking commands (`npx vitest`, `cat >`) with
  `</dev/null`, or a stray stdin read hangs the shell.

- Milkdown's presets are flat arrays of plugins, and `$nodeSchema` /
  `$useKeymap` / `$remark` return pairs. To replace a piece (as lists.ts
  replaces Milkdown's lists), leave its plugins out with `without()` in
  editor.ts rather than patching around them.
- Milkdown's serializer never runs remark transformers. To change the
  Markdown tree before it's written, wrap `serializerCtx` (see
  `joinListsOnSave` in lists.ts); the clipboard reads it lazily, so it
  gets the wrapper too.

## Merging PRs

- After merging a PR, switch the checkout back to `main` (and pull) **before** settling/organizing the thread.
