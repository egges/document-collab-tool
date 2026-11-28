// Toggles, as in Notion: a line with an arrow, and blocks folded under it.
// The line is text (a toggle list) or a heading (a toggle heading). A toggle
// holds its line and, after it, the blocks nested in it, as a list item
// holds its line and nested blocks.
//
// In Markdown a toggle is a `<details>` element, so it folds on GitHub too:
//
//     <details>
//     <summary><h2>Agent steps</h2></summary>
//
//     Read 14 emails, drafted 3 replies.
//
//     </details>
//
// The blank lines keep the content Markdown. A toggle list's summary is just
// its text: `<summary>Agent steps</summary>`. The line is HTML, so its
// formatting is written as HTML (`<strong>`, `<a href>`...) too.
//
// Whether a toggle is open is per device and isn't saved: toggles start
// closed when a page opens, a new one starts open, and one opens when the
// cursor goes into what it hides (a search, undo, a drop).
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { Fragment, DOMParser as SchemaParser, type Mark, type Node, type NodeType, type Schema } from "@milkdown/kit/prose/model";
import { type Command, type EditorState, NodeSelection, Plugin, PluginKey, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import { findWrapping } from "@milkdown/kit/prose/transform";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { $nodeSchema, $prose, $remark, $useKeymap } from "@milkdown/kit/utils";
import { type Block, blockStartingAt } from "./blocks.ts";

export const EMPTY_TOGGLE_HINT = "Empty toggle. Click or drop blocks inside.";

export const toggleSchema = $nodeSchema("toggle", () => ({
  group: "block",
  content: "(paragraph | heading) block*",
  defining: true,
  parseDOM: [{ tag: "div.page-toggle", contentElement: ".page-toggle-content" }],
  toDOM: () => [
    "div",
    { class: "page-toggle" },
    ["button", { class: "page-toggle-arrow", type: "button", contenteditable: "false", tabindex: "-1", "aria-label": "Open or close" }],
    ["div", { class: "page-toggle-content" }, 0],
  ],
  parseMarkdown: {
    match: ({ type }) => type === "toggle",
    runner: (state, node, type) => {
      const { level, title } = node as typeof node & ToggleNotes;
      const line = parseLine(state.schema, title, level);
      state.openNode(type);
      state.addNode(line.type, line.attrs, contentOf(line));
      state.next(node.children);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "toggle",
    runner: (state, node) => {
      const line = node.firstChild!;
      const h = line.type.name === "heading" ? `h${line.attrs.level}` : null;
      const summary = h ? `<${h}>${lineHtml(line)}</${h}>` : lineHtml(line);
      state.addNode("html", undefined, `<details>\n<summary>${summary}</summary>`);
      state.next(node.content.cut(line.nodeSize));
      state.addNode("html", undefined, "</details>");
    },
  },
}));

// --- Reading Markdown ---------------------------------------------------------

/** What a toggle read from Markdown carries, besides its nested blocks. */
interface ToggleNotes {
  /** The heading's level, or 0 for a toggle list. */
  level: number;
  /** The line's HTML: the summary, from inside its `<hN>` for a heading. */
  title: string;
}

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

const DETAILS_START = /^<details(?:\s+open(?:="[^"]*")?)?\s*>\s*<summary>([\s\S]*?)<\/summary>$/i;
const HEADING = /^<h([1-6])>([\s\S]*?)<\/h\1>$/i;
/** Summaries holding blocks other than one heading stay raw HTML: a line can't show them. */
const BLOCK_TAG = /<\/?(?:p|div|h[1-6]|ul|ol|li|table|pre|blockquote|details|summary|hr)\b/i;

/** What a toggle's line is, from its summary's HTML. Null when it can't be one line. */
function readSummary(html: string): { level: number; title: string } | null {
  const inner = html.trim();
  const heading = inner.match(HEADING);
  if (heading) return BLOCK_TAG.test(heading[2]) ? null : { level: Number(heading[1]), title: heading[2].trim() };
  return BLOCK_TAG.test(inner) ? null : { level: 0, title: inner };
}
const DETAILS_END = /^<\/details\s*>$/i;

/**
 * The HTML a block is, if it's one: an HTML block, or the paragraph
 * Milkdown wraps one in (its `remarkHtmlTransformer` runs before us).
 */
function htmlOf(node: MarkdownNode): string | null {
  if (node.type === "html") return node.value ?? "";
  const only = node.type === "paragraph" && node.children?.length === 1 ? node.children[0] : null;
  return only?.type === "html" ? (only.value ?? "") : null;
}

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

/** The index of the `</details>` closing the toggle that starts at `start`, or -1. */
function closingIndex(children: MarkdownNode[], start: number): number {
  let depth = 0;
  for (let i = start; i < children.length; i++) {
    const html = htmlOf(children[i]);
    if (html === null) continue;
    depth += count(html, /<details[\s>]/gi) - count(html, /<\/details\s*>/gi);
    if (depth === 0) return DETAILS_END.test(html.trim()) ? i : -1;
    if (depth < 0) return -1;
  }
  return -1;
}

/**
 * Turns each `<details>` with a line of text or a heading for its summary,
 * the blocks after it and its `</details>` (side by side in Markdown's tree)
 * into one toggle holding those blocks, at every level. Anything else stays
 * raw HTML.
 */
export function groupToggles(node: MarkdownNode): void {
  if (!node.children) return;
  const children = node.children;
  const grouped: MarkdownNode[] = [];
  for (let i = 0; i < children.length; i++) {
    const match = htmlOf(children[i])?.trim().match(DETAILS_START);
    const summary = match && readSummary(match[1]);
    const end = summary ? closingIndex(children, i) : -1;
    if (summary && end > i) {
      const toggle: MarkdownNode & ToggleNotes = { type: "toggle", ...summary, children: children.slice(i + 1, end) };
      grouped.push(toggle);
      i = end;
    } else {
      grouped.push(children[i]);
    }
  }
  node.children = grouped;
  grouped.forEach(groupToggles);
}

export const remarkToggles = $remark("pageToggles", () => () => (tree) => groupToggles(tree as MarkdownNode));

// --- The line as HTML ---------------------------------------------------------

/** HTML tags for the marks a toggle's line can have. */
const MARK_TAGS: Record<string, (mark: Mark) => [open: string, close: string]> = {
  link: (mark) => [`<a href="${escapeHtml(String(mark.attrs.href ?? ""))}">`, "</a>"],
  strong: () => ["<strong>", "</strong>"],
  emphasis: () => ["<em>", "</em>"],
  strike_through: () => ["<del>", "</del>"],
  inlineCode: () => ["<code>", "</code>"],
};

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The line's text and formatting as HTML, for its `<summary>`. */
export function lineHtml(line: Node): string {
  let html = "";
  const open: Mark[] = [];
  const closeTo = (keep: number) => {
    while (open.length > keep) {
      const mark = open.pop()!;
      html += MARK_TAGS[mark.type.name](mark)[1];
    }
  };
  line.forEach((child, _offset, index) => {
    const marks = child.marks.filter((m) => MARK_TAGS[m.type.name]);
    let same = 0;
    while (same < open.length && same < marks.length && open[same].eq(marks[same])) same++;
    closeTo(same);
    for (const mark of marks.slice(same)) {
      html += MARK_TAGS[mark.type.name](mark)[0];
      open.push(mark);
    }
    // Spaces at the start would be trimmed when read back.
    if (child.isText) html += escapeHtml(child.text!).replace(/^ +/, (spaces) => (index === 0 ? "&#32;".repeat(spaces.length) : spaces));
    else if (child.type.name === "hardbreak") html += "<br>";
    else if (child.type.name === "image") html += imageHtml(child);
    else if (child.type.name === "html") html += child.attrs.value;
    else html += escapeHtml(child.textContent);
  });
  closeTo(0);
  return html;
}

function imageHtml(image: Node): string {
  const { src, alt, title } = image.attrs;
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt ?? "")}"${title ? ` title="${escapeHtml(title)}"` : ""}>`;
}

/**
 * A toggle's line from its summary's HTML: a heading of `level`, or text for
 * level 0. Read with the editor's own rules for pasted HTML; an inert
 * document parses it, so nothing in it runs.
 */
function parseLine(schema: Schema, html: string, level: number): Node {
  const line = level ? schema.nodes.heading.create({ level }) : schema.nodes.paragraph.create();
  if (!html) return line;
  const body = new window.DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html").body;
  const parsed = SchemaParser.fromSchema(schema).parse(body, { topNode: line, preserveWhitespace: true });
  // Pasted HTML reads an image without a title as titled with its alt text;
  // here a title is only what was written.
  const titles = [...body.querySelectorAll("img")].map((img) => img.getAttribute("title") ?? "");
  const content = contentOf(parsed).map((child) =>
    child.type.name === "image" ? child.type.create({ ...child.attrs, title: titles.shift() ?? "" }, null, child.marks) : child,
  );
  return parsed.copy(Fragment.fromArray(content));
}

const contentOf = (node: Node) => {
  const nodes: Node[] = [];
  node.forEach((child) => nodes.push(child));
  return nodes;
};

// --- Where the cursor is ------------------------------------------------------

const isToggle = (node: Node | null | undefined): boolean => node?.type.name === "toggle";

/** The toggle whose line the selection is in. */
export function toggleAtCursor(state: EditorState): Block | null {
  const { $from } = state.selection;
  if (state.selection instanceof NodeSelection || $from.depth < 2) return null;
  const toggle = $from.node(-1);
  if (!isToggle(toggle) || $from.index(-1) !== 0) return null;
  return { pos: $from.before(-1), node: toggle };
}

/** Where the blocks folded in the toggle at `pos` start: right after its line. */
const bodyStart = (pos: number, toggle: Node) => pos + 1 + toggle.firstChild!.nodeSize;

// --- Open and closed ----------------------------------------------------------

/** The closed toggles, by position. Everything else is open. */
const foldKey = new PluginKey<number[]>("page-toggles");

type FoldChange = { pos: number; folded: boolean };

export function isFolded(state: EditorState, pos: number): boolean {
  return foldKey.getState(state)?.includes(pos) ?? false;
}

/** Opens or closes the toggle at `pos`. Closing it takes the cursor out of what it hides. */
export function setFolded(state: EditorState, pos: number, folded: boolean): Transaction {
  const tr = state.tr.setMeta(foldKey, { pos, folded } satisfies FoldChange);
  const toggle = state.doc.nodeAt(pos);
  if (folded && toggle) {
    const start = bodyStart(pos, toggle);
    const end = pos + toggle.nodeSize - 1;
    const { from, to } = state.selection;
    if ((from >= start && from <= end) || (to >= start && to <= end)) {
      tr.setSelection(TextSelection.create(tr.doc, start - 1));
    }
  }
  return tr;
}

function allToggles(doc: Node): number[] {
  const found: number[] = [];
  doc.descendants((node, pos) => {
    if (isToggle(node)) found.push(pos);
    return !node.isTextblock;
  });
  return found;
}

/** Whether `pos` is among the blocks folded in the toggle at `at`. */
function hides(doc: Node, at: number, pos: number): boolean {
  const toggle = doc.nodeAt(at)!;
  return toggle.childCount > 1 && pos >= bodyStart(at, toggle) && pos < at + toggle.nodeSize;
}

/**
 * The toggles among `lost` that the change put back somewhere else: moving
 * a block deletes it and inserts a copy, which would otherwise count as a
 * new toggle and open. A toggle added by the change with the same line as
 * one it removed is that one, moved (with what's in it, or not: Shift-Tab
 * takes the blocks after it along).
 */
function movedHere(tr: Transaction, before: Node, after: Node, lost: Node[]): number[] {
  const kept = new Set<number>();
  for (const pos of allToggles(before)) {
    const mapped = tr.mapping.mapResult(pos, 1);
    if (!mapped.deleted) kept.add(mapped.pos);
  }
  const moved: number[] = [];
  for (const pos of allToggles(after)) {
    if (kept.has(pos)) continue;
    const line = after.nodeAt(pos)!.firstChild!;
    const match = lost.findIndex((toggle) => toggle.firstChild!.eq(line));
    if (match < 0) continue;
    lost.splice(match, 1);
    moved.push(pos);
  }
  return moved;
}

function foldPlugin(): Plugin {
  return new Plugin({
    key: foldKey,
    state: {
      // A page opens with its toggles closed.
      init: (_config, state) => allToggles(state.doc),
      apply: (tr, folded, old, state) => {
        let next = folded;
        if (tr.docChanged) {
          next = [];
          const lost: Node[] = []; // closed toggles the change removed
          for (const pos of folded) {
            const mapped = tr.mapping.mapResult(pos, 1);
            if (!mapped.deleted && isToggle(state.doc.nodeAt(mapped.pos))) next.push(mapped.pos);
            else lost.push(old.doc.nodeAt(pos)!);
          }
          if (lost.length) next.push(...movedHere(tr, old.doc, state.doc, lost));
        }
        const change = tr.getMeta(foldKey) as FoldChange | undefined;
        if (change) next = change.folded ? [...next.filter((p) => p !== change.pos), change.pos] : next.filter((p) => p !== change.pos);
        // Never hide the cursor: the toggles around it open.
        const { anchor, head } = state.selection;
        const hiding = next.filter((p) => hides(state.doc, p, anchor) || hides(state.doc, p, head));
        if (hiding.length) next = next.filter((p) => !hiding.includes(p));
        return next;
      },
    },
    props: {
      decorations(state) {
        const folded = foldKey.getState(state)!;
        const decorations: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (!isToggle(node)) return !node.isTextblock;
          if (folded.includes(pos)) {
            decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "page-toggle-closed" }));
          } else if (node.childCount === 1) {
            decorations.push(Decoration.widget(bodyStart(pos, node), emptyHint, { side: 1, key: "empty-toggle", ignoreSelection: true }));
          }
          return true;
        });
        return DecorationSet.create(state.doc, decorations);
      },
      handleDOMEvents: {
        mousedown: (view, event) => {
          const target = event.target as HTMLElement | null;
          const arrow = target?.closest?.(".page-toggle-arrow");
          const hint = target?.closest?.(".page-toggle-empty");
          if (!arrow && !hint) return false;
          const pos = togglePosOf(view, (arrow ?? hint)!.closest(".page-toggle")!);
          if (pos === null) return false;
          event.preventDefault();
          if (arrow) view.dispatch(setFolded(view.state, pos, !isFolded(view.state, pos)));
          else {
            view.dispatch(addFirstBlock(view.state, pos));
            view.focus();
          }
          return true;
        },
      },
    },
  });
}

function emptyHint(): HTMLElement {
  const hint = document.createElement("div");
  hint.className = "page-toggle-empty";
  hint.contentEditable = "false";
  hint.textContent = EMPTY_TOGGLE_HINT;
  return hint;
}

/** The position of the toggle drawn as `element`. */
function togglePosOf(view: EditorView, element: Element): number | null {
  const line = element.querySelector(":scope > .page-toggle-content > :first-child");
  if (!line) return null;
  const $pos = view.state.doc.resolve(view.posAtDOM(line, 0));
  for (let depth = $pos.depth; depth > 0; depth--) if (isToggle($pos.node(depth))) return $pos.before(depth);
  return null;
}

/** An empty first block in the toggle at `pos`, with the cursor in it. */
function addFirstBlock(state: EditorState, pos: number): Transaction {
  const toggle = state.doc.nodeAt(pos)!;
  const at = bodyStart(pos, toggle);
  const tr = state.tr.insert(at, state.schema.nodes.paragraph.create());
  return tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView();
}

// --- Commands -----------------------------------------------------------------

/**
 * Makes the block the cursor is in a toggle: a toggle heading of `level`, or
 * a toggle list for 0. A toggle's line changes in place; a paragraph or
 * heading becomes a new toggle's line, open. Null when the cursor's block
 * can't be one (code, a table cell).
 */
export function setToggle(state: EditorState, level: number): Transaction | null {
  const { $from } = state.selection;
  const block = $from.parent;
  if (!block.isTextblock || block.type.spec.code || $from.depth < 1) return null;
  const { heading, paragraph } = state.schema.nodes;
  const toggle: NodeType = state.schema.nodes.toggle;
  const inToggle = !!toggleAtCursor(state);
  // A toggle has to fit where the block is (not in a table cell, say).
  if (!inToggle && !$from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), toggle)) return null;
  const type = level ? heading : paragraph;
  const attrs = level ? { level } : null;
  const pos = $from.before();
  const tr = state.tr;
  if (block.type === type) tr.setNodeMarkup(pos, undefined, { ...block.attrs, ...attrs });
  else tr.setNodeMarkup(pos, type, attrs);
  if (inToggle) return tr;
  const range = tr.doc.resolve(pos + 1).blockRange();
  const wrapping = range && findWrapping(range, toggle);
  if (!range || !wrapping) return null;
  return tr.wrap(range, wrapping);
}

/** The toggle the cursor's line is in becomes that line and its blocks, in place. */
export function toggleToBlocks(state: EditorState): Transaction | null {
  const toggle = toggleAtCursor(state);
  if (!toggle) return null;
  const tr = state.tr.replaceWith(toggle.pos, toggle.pos + toggle.node.nodeSize, toggle.node.content);
  const { anchor, head } = state.selection;
  return tr.setSelection(TextSelection.create(tr.doc, anchor - 1, head - 1));
}

/**
 * Enter in a toggle's line, as in Notion: the text after the cursor goes to
 * a new block, the first one in the toggle. At the end of a closed toggle's
 * line the new, empty block goes after the toggle instead (another toggle,
 * after a toggle list), and at the start of the line an empty block goes
 * above it. On an empty toggle list with nothing in it, the toggle becomes
 * text, as an empty list item does.
 */
const enter: Command = (state, dispatch) => {
  const toggle = toggleAtCursor(state);
  const { selection } = state;
  if (!toggle || !(selection instanceof TextSelection) || selection.$from.parent !== selection.$to.parent) return false;
  const paragraph = state.schema.nodes.paragraph;
  const isList = toggle.node.firstChild!.type === paragraph;
  if (isList && toggle.node.childCount === 1 && toggle.node.firstChild!.content.size === 0) {
    const tr = toggleToBlocks(state);
    if (tr) dispatch?.(tr.scrollIntoView());
    return !!tr;
  }
  if (!dispatch) return true;
  const tr = state.tr.deleteSelection();
  const $pos = tr.selection.$from;
  const line = $pos.parent;
  if ($pos.parentOffset === 0 && line.content.size > 0) {
    tr.insert(toggle.pos, isList ? toggle.node.type.create(null, paragraph.create()) : paragraph.create());
  } else {
    const rest = line.content.cut($pos.parentOffset);
    tr.delete($pos.pos, $pos.end());
    const node = tr.doc.nodeAt(toggle.pos)!;
    // Text never moves past the blocks a closed toggle hides: it opens.
    const after = rest.size === 0 && isFolded(state, toggle.pos);
    const at = after ? toggle.pos + node.nodeSize : bodyStart(toggle.pos, node);
    const block = after && isList ? toggle.node.type.create(null, paragraph.create()) : paragraph.create(null, rest);
    tr.insert(at, block);
    tr.setSelection(TextSelection.create(tr.doc, at + (block.type === paragraph ? 1 : 2)));
  }
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Backspace at the start of a toggle's line: the toggle becomes its line
 * (text, or a plain heading), its blocks staying where they are.
 */
const backspace: Command = (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty || selection.$from.parentOffset !== 0) return false;
  const tr = toggleToBlocks(state);
  if (tr) dispatch?.(tr);
  return !!tr;
};

/** ⌘Enter on a toggle's line (or a selected toggle): opens or closes it. */
const flip: Command = (state, dispatch) => {
  const { selection } = state;
  const selected = selection instanceof NodeSelection ? blockStartingAt(state.doc, selection.from) : null;
  const toggle = selected && isToggle(selected.node) ? selected : toggleAtCursor(state);
  if (!toggle) return false;
  dispatch?.(setFolded(state, toggle.pos, !isFolded(state, toggle.pos)));
  return true;
};

export const toggleKeymap = $useKeymap("pageToggles", {
  NewBlock: { shortcuts: "Enter", priority: 60, command: () => enter },
  ToLine: { shortcuts: "Backspace", priority: 60, command: () => backspace },
  OpenOrClose: { shortcuts: "Mod-Enter", priority: 60, command: () => flip },
});

export const toggles: MilkdownPlugin[] = [toggleSchema, remarkToggles, toggleKeymap, $prose(() => foldPlugin())].flat();
