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

When you add a block type, add an example page that uses it. When a change to
the output is deliberate, update the reviewed output with `npx vitest run -u`
and check the diff in `__formatted__/` before committing.
