# Editor round-trip test

Can a rich-text editor open a Markdown page and save it again without
rewriting it? Every page is a file in Git, and sync merges line by line, so an
editor that rewrites lines nobody touched creates noisy history and needless
conflicts (see [docs/roadmap.md](../../docs/roadmap.md), step 3).

This is a throwaway test, not product code. It runs the editors headless in
Node with jsdom, through the same parse and serialize code they use in the
browser.

```sh
npm install
npm test          # writes results/REPORT.md and the saved files in results/<editor>/
```

## What it checks

For each file in [`corpus/`](corpus) (12 realistic pages: notes, lists, code,
tables, wrapped prose, links, front matter, HTML and footnotes, escaping, a
page written by an AI agent) and each editor:

1. **Open + save, no edits.** Is the saved file identical? If not, is it
   *rewritten but renders the same*, does the *rendering change*, or does the
   *visible text change*? A reference CommonMark + GFM parser (micromark)
   decides which.
2. **Stability.** Does saving an already-saved file change it again?
3. **One-word edit.** After one word in an already-saved file is changed, how
   many lines differ? Ideally 2 (one line removed, one added).

Editors tested (versions pinned in `package.json`):

- Tiptap 3.35 with the official `@tiptap/markdown` extension
- Tiptap 3.35 with the community `tiptap-markdown` 0.9 extension
- BlockNote 0.57 (`blocksToMarkdownLossy`)

## Results

| | Tiptap + `@tiptap/markdown` | Tiptap + `tiptap-markdown` | BlockNote |
|---|---|---|---|
| Identical after open + save | 1 / 12 | 1 / 12 | 0 / 12 |
| Rewritten, renders the same | 7 | 6 | 2 |
| Rendering changed | 1 | 3 | 7 |
| Visible text changed | 3 | 2 | 3 |
| Changes again on a second save | 1 (front matter only) | 0 | 3 |
| One-word edit changes exactly 1 line | 10 / 12 | 11 / 11 | 9 / 12 |
| Keeps hard-wrapped lines | yes | no, joins them | no, adds `\` breaks |

None of the editors round-trips Markdown untouched. As expected, every one
rewrites pages into its own style.

### BlockNote: ruled out

- Turns every soft line break into a hard break (`\` at the end of each line).
  That changes how every wrapped paragraph renders.
- Drops link and image titles, flattens nested quotes, and turns an indented
  code block into a normal paragraph.
- 3 files change again on a second save.

Its own API calls the export "lossy", and this test confirms it. Using
BlockNote would mean writing our own Markdown serializer for it.

### Community `tiptap-markdown`: ruled out

- Joins hard-wrapped paragraphs into one long line. Git merges by line, so two
  people editing different sentences of one paragraph would always conflict.
- Drops table column alignment, and drops raw HTML even with `html: true`.
- It's a small, one-maintainer project, and the official extension below
  replaces it.

### Tiptap + `@tiptap/markdown`: usable, with fixes

Most of its changes are a one-time switch to a consistent style that renders
the same: `-` bullets, `*emphasis*`, `#` headings, fenced code, `---` rules,
renumbered lists, and inline links instead of reference links. It keeps
line wrapping, and after that first save a one-word edit changes exactly one
line. That's the "workable" outcome: convert each page once, and from then on
only real edits show up as changes.

Things that need fixing before we rely on it, roughly in order of importance:

1. **Raw HTML, HTML comments and footnotes are lost.** `<details>`, `<kbd>`,
   `<!-- -->` and `[^1]` footnotes are dropped or escaped. That is data loss for
   imported pages and for pages that agents edit. Fix: a node that keeps raw
   HTML as-is, plus a footnote extension.
2. **Escaping bugs.** `1986\.` loses its escape and turns into a numbered list
   starting at 1986 the next time the page is opened. It also adds
   unnecessary escapes: `snake\_case\_name`, `5 \* 3`, `C:\\Users`. Those
   render the same, but they make the raw files harder to read and break plain
   text search for `snake_case_name`.
3. **Tables are padded to column width.** Editing one cell so a column gets
   wider rewrites every row of the table (10 lines for a one-word edit in
   `04-table.md`). It also writes a malformed delimiter row and extra blank
   lines. Fix: our own table serializer without padding (extensions can
   override `renderMarkdown`).
4. **Trailing newline is inconsistent.** Sometimes missing, sometimes doubled.
   Fix: always end the file with exactly one newline when saving.
5. **Front matter is destroyed and unstable.** This doesn't affect our own
   format, which keeps metadata in `meta.json`, but the importer must move
   front matter into `meta.json` before a page reaches the editor.

## Recommendation

Use **Tiptap with `@tiptap/markdown`**. This doesn't change the sync design.

- **Only write a page when the user actually changed it.** Opening a page
  must never save it. Then the one-time style conversion only happens on a
  page's first real edit, or on import.
- **Fix items 1–4 above** with our own extensions and a thin save wrapper, and
  turn this corpus into a regression test for them. That's days of work, not
  a custom editor.
- **Add a safety check on save.** Re-parse what we're about to write. If its
  visible text differs from the editor's document, keep the old file and log
  it rather than lose content.
