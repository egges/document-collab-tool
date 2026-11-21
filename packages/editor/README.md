# Page editor

The editor for pages: [Milkdown](https://milkdown.dev) set up so that saving
a page only changes the lines someone actually edited. Every page is a file in
Git and sync merges line by line, so this matters more than anything else
about the editor. Why Milkdown, and how it compared with Tiptap and BlockNote:
[spikes/editor-roundtrip](../../spikes/editor-roundtrip).

```sh
npm install
npm test           # regression tests on the example pages
npm run typecheck
npm run dev        # demo: edit a page and see exactly what would be saved
```

## Using it

In React, `<PageEditorView>` is the editor with its menus:

- **Toolbar** above a text selection: turn into (text, headings, lists, to-do,
  quote, code), bold, italic, strikethrough, code and link.
- **Slash menu**: type `/` on an empty line, filter by typing, pick with the
  arrow keys and Enter (or the mouse), close with Escape.
- **To-dos**: click the box to tick an item.
- **Blocks**, as in Notion: every top-level element is a block, and so is
  every list item. Pointing at one shows a handle in the left margin (leave
  about 48px for it). **+** adds a block below (⌥-click: above) and opens the
  slash menu. Drag **⋮⋮** to move the block; a line shows where it will land.
  A list item dragged out of its list becomes a list of its own, and a block
  dropped into a list becomes an item (a to-do, among to-dos). Click ⋮⋮ for
  the block menu: turn into, duplicate, copy (as Markdown), move up or down,
  delete. Keys: Esc selects the block the cursor is in, then Backspace
  deletes it and Enter goes back to its text; ⌘D duplicates; ⌘⇧↑ / ⌘⇧↓ move
  it. Every one of these is a single undo step.
- **Code blocks**: type ```` ``` ```` at the start of a line and it becomes a
  code block straight away. The code is highlighted (about 35 languages, via
  [lowlight](https://github.com/wooorm/lowlight)), and the language is
  detected by itself: when you paste into a block, or when you finish typing
  and move on, it's written into the fence (```` ```python ````). Pointing at a
  block shows a searchable language menu and a copy button. A language that
  was picked by hand or came with the file is never changed, and opening a
  page never adds one.
- **Editing code** works as in a code editor: brackets and quotes close
  themselves (and typing the closer steps over it); Enter keeps the
  indentation and adds a level after `{`, `(`, `[` (and `:` in Python and
  YAML); Tab / Shift-Tab and ⌘] / ⌘[ indent and outdent lines; ⌥↑ / ⌥↓ move
  lines and ⇧⌥↑ / ⇧⌥↓ copy them; ⌘/ comments lines out and back in; Home goes
  to the first character of the line, then its start; Backspace in the
  indentation goes back a level. ⌘↩ (or ↑ / ↓ past the first or last line of
  the page) moves on to text, Backspace in an empty block makes it text
  again, and ⌘A selects just the code.

```tsx
import { PageEditorView } from "@document-collab-tool/editor/react";
import "@document-collab-tool/editor/style.css";

<PageEditorView
  markdown={pageMd}                          // changing it loads the new version
  onReady={(editor) => (editorRef.current = editor)}
  onDirtyChange={(dirty) => showUnsaved(dirty)}
/>
```

Saving goes through the editor object from `onReady`, the same as without
React:

```ts
import { createPageEditor, SaveRefusedError } from "@document-collab-tool/editor";
import "@document-collab-tool/editor/style.css";

const editor = await createPageEditor({
  root: element,
  markdown: pageMd,                       // contents of page.md
  onDirtyChange: (dirty) => showUnsaved(dirty),
});

// When it's time to write, for example shortly after the last keystroke:
try {
  const markdown = editor.save();         // null when nothing changed
  if (markdown !== null) {
    await writePage(markdown);            // the app writes page.md; docsync commits it
    editor.markSaved();
  }
} catch (e) {
  if (e instanceof SaveRefusedError) reportBug(e.detail);  // keep the old file
}

editor.load(newerPageMd);                 // after sync pulled a newer version
```

The menus are built on the framework-free core: `editor.commands` (toggle a
format, set a block type, set a link, tick a to-do) and `formatState()` /
`slashState()` for what's active. Those are tested without a browser, so the
React layer stays thin. Theme it by overriding the `--page-*` custom
properties on `.page-editor` in `style.css`.

The editor never writes files. It only produces the Markdown and leaves
writing, timing and syncing to the app.

## The rules it enforces

- **Opening a page never changes it.** `save()` returns null until someone
  edits the page, and again after they undo back to the saved version. So a
  page is only rewritten in our house style on its first real edit.
- **House style.** `-` for bullets and rules, and tables without column
  padding, so editing one table cell changes one line (`src/markdown.ts`).
- **Front matter is kept as-is.** The editor can't show YAML front matter, so
  it's set aside on open and put back on save.
- **Exactly one newline at the end of the file.**
- **Empty lines aren't saved.** An empty paragraph (pressing Enter twice) is
  spacing in the editor, but Markdown can't store it: Milkdown would write a
  `<br />` line. If the only change is an empty line, `save()` returns null.
- **Safety check on every save.** The Markdown is read back before it's
  returned. If it would show less than the editor does (a missing paragraph,
  image or HTML element, or changed text), `save()` throws `SaveRefusedError`
  instead (`src/check.ts`).

## Tests

`test/pages/` holds realistic example pages: notes, lists, code, tables,
wrapped prose, links, front matter, raw HTML and footnotes, escaping, and a
page written by an AI agent. For each one the tests check that:

- the first save renders exactly the same as the original,
- the first save matches the reviewed output in `test/pages/__formatted__/`,
- saving again changes nothing,
- opening the page doesn't mark it as changed,
- a one-word edit changes exactly one line.

`test/commands.test.ts` checks the Markdown each toolbar and menu command
saves, `test/blocks.test.ts` the block operations (delete, duplicate, move,
drop into and out of lists, add, turn into, the keys), and
`test/react.test.tsx` checks the React menus: one editor under StrictMode,
the toolbar formatting a selection, the slash menu's filtering, keyboard
navigation and Escape, and the block handle's menu, "+" and dragging.

When you add a block type, add an example page that uses it. When a change to
the output is deliberate, update the reviewed output with `npx vitest run -u`
and check the diff in `__formatted__/` before committing.
