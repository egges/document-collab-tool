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
- Milkdown 7.23 with the commonmark and GFM presets, once with default
  settings and once with our "house style": `-` for bullets and rules, and
  tables without column padding

## Results

| | Tiptap + `@tiptap/markdown` | Tiptap + `tiptap-markdown` | BlockNote | Milkdown | Milkdown, house style |
|---|---|---|---|---|---|
| Identical after open + save | 1 / 12 | 1 / 12 | 0 / 12 | 1 / 12 | **3 / 12** |
| Rewritten, renders the same | 7 | 6 | 2 | 10 | 8 |
| Rendering changed | 1 | 3 | 7 | 0 | **0** |
| Visible text changed | 3 | 2 | 3 | 1 | **1** (front matter) |
| Changes again on a second save | 1 | 0 | 3 | 0 | **0** |
| One-word edit changes exactly 1 line | 10 / 12 | 11 / 11 | 9 / 12 | 10 / 11 | **11 / 11** |
| Keeps hard-wrapped lines | yes | no, joins them | no, adds `\` breaks | yes | yes |
| Keeps raw HTML, comments, footnotes | no | no | partly | yes | yes |

None of the editors round-trips every page untouched: each rewrites pages
into one consistent style. Milkdown is the only one whose rewrites never
change what a page shows (front matter aside).

### Milkdown, house style: recommended

Milkdown reads and writes Markdown through remark, a widely used Markdown
library, instead of its own converter. That's why it does so much better:

- Raw HTML, HTML comments and footnotes are kept exactly. `08-html-footnotes.md`
  comes back byte for byte.
- No escaping bugs. `1986\.`, `snake_case_name` and `C:\Users\sam` all stay
  as written. It adds only two harmless escapes (`5 \* 3`, `AT\&T`).
- Wrapped lines stay wrapped, so line-by-line merging keeps working.
- Its output style is a remark setting, not hard-coded. Two settings (bullets
  as `-`, and `tablePipeAlign: false` for tables) make our files match the
  most common style. Without padding, editing one table cell changes one
  line; with padding (the default) it changed 10.

The remaining rewrites are a one-time switch to a consistent style that
renders the same: `#` headings instead of underlined ones, fenced code,
renumbered lists (`1. 1. 1.` becomes `1. 2. 3.`), and inline links instead of
reference links.

The one real loss is front matter, which becomes a horizontal rule and a
heading. That doesn't affect our own format, which keeps metadata in
`meta.json`, but the importer must move front matter into `meta.json` before
a page reaches the editor.

### Tiptap + `@tiptap/markdown`: usable, but needs fixes

It keeps line wrapping and is stable after the first save, but:

1. **Raw HTML, HTML comments and footnotes are lost.** That's data loss for
   imported pages and for pages that agents edit.
2. **Escaping bugs.** `1986\.` loses its escape and turns into a numbered list
   starting at 1986 the next time the page is opened. It also adds
   unnecessary escapes (`snake\_case\_name`, `C:\\Users`), which break plain
   text search.
3. **Tables are padded,** and it writes a malformed delimiter row and extra
   blank lines.
4. **The trailing newline is inconsistent.**

All four can be fixed with our own extensions, but Milkdown gets them right
without any.

### BlockNote: ruled out

- Turns every soft line break into a hard break (`\` at the end of each line).
  That changes how every wrapped paragraph renders.
- Drops link and image titles, flattens nested quotes, and turns an indented
  code block into a normal paragraph.
- 3 files change again on a second save.

Its own API calls the export "lossy", and this test confirms it.

### Community `tiptap-markdown`: ruled out

- Joins hard-wrapped paragraphs into one long line. Git merges by line, so two
  people editing different sentences of one paragraph would always conflict.
- Drops table column alignment, and drops raw HTML even with `html: true`.
- The official extension above replaces it.

## Recommendation

Use **Milkdown with the house-style settings**. This doesn't change the sync
design.

Why it fits beyond these numbers: in Milkdown, every kind of block has to
say how it's written as Markdown, through remark's syntax tree. That's
exactly our constraint. Every Notion-style feature we add (callouts, toggles,
page links, columns) needs a Markdown form anyway, and Milkdown makes us
define it up front.

Trade-offs compared with Tiptap:

- **Smaller ecosystem.** Tiptap has more ready-made extensions, a company
  behind it and much more usage. Milkdown is mostly the work of one main
  maintainer. Both sit on ProseMirror and Milkdown on remark, which are large,
  well-maintained projects, so the risk is limited: in the worst case we
  maintain a fork of a fairly thin layer.
- **React integration needs more glue.** Tiptap has first-class React node
  views. Milkdown doesn't depend on any framework, and React node views go
  through an adapter (`@prosemirror-adapter/react`, by the same author).
- **Notion-style UI.** Milkdown has plugins for a slash menu, a block drag
  handle, tooltips and uploads, and Crepe, a ready-made editor built from
  them. That's a head start comparable to Tiptap's.

Rules that apply whichever editor we use:

- **Only write a page when the user actually changed it.** Opening a page
  must never save it. Then the one-time style conversion only happens on a
  page's first real edit, or on import.
- **Turn this corpus into a regression test** for the editor package, and add
  pages for each new block type.
- **Add a safety check on save.** Re-parse what we're about to write. If its
  visible text differs from the editor's document, keep the old file and log
  it rather than lose content.
