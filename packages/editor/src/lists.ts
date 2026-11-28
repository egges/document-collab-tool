// Lists, as in Notion: every list item is a block of its own, next to the
// blocks around it. There's no list node around items; a run of items side
// by side is what reads as a list. An item holds its line of text (a
// paragraph) and, after it, the blocks nested under it.
//
// Markdown has lists that contain items, so they're converted on the way in
// and out: a list is read as its items (`remarkListItems` notes what each
// item needs to know about its list), and on save each item is written as a
// list of one, after which lists side by side are joined (`joinLists`).
//
// Numbers are drawn by CSS counters (style.css): a numbered item counts on
// from the numbered item before it, unless it has a `start` of its own.
import { SerializerReady, remarkCtx, schemaCtx, serializerCtx } from "@milkdown/kit/core";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import type { Attrs, Node, NodeType } from "@milkdown/kit/prose/model";
import { type Command, type EditorState, NodeSelection, type Selection, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import { findWrapping } from "@milkdown/kit/prose/transform";
import { SerializerState } from "@milkdown/kit/transformer";
import { $inputRule, $nodeSchema, $remark, $useKeymap } from "@milkdown/kit/utils";
import { type Block, blockStartingAt } from "./blocks.ts";

export type ListType = "bullet" | "ordered";

export const listItemSchema = $nodeSchema("list_item", () => ({
  group: "block",
  content: "paragraph block*",
  defining: true,
  attrs: {
    listType: { default: "bullet", validate: "string" },
    /** A to-do: ticked or not. Null for an ordinary item. */
    checked: { default: null, validate: "boolean|null" },
    /** A numbered item that starts counting again, at this number. */
    start: { default: null, validate: "number|null" },
    /** Blank lines between the item's own blocks in Markdown. */
    spread: { default: false, validate: "boolean" },
    /** Blank lines between the items of its list in Markdown. */
    loose: { default: false, validate: "boolean" },
  },
  parseDOM: [
    {
      tag: "li",
      getAttrs: (dom) => {
        const li = dom as HTMLElement;
        const checked = li.dataset.checked;
        return {
          listType: li.dataset.listType ?? (li.parentElement?.tagName === "OL" ? "ordered" : "bullet"),
          checked: checked === "true" ? true : checked === "false" ? false : null,
        };
      },
    },
  ],
  toDOM: (node) => {
    const { listType, checked, start } = node.attrs;
    return [
      "li",
      {
        "data-list-type": listType,
        ...(checked != null ? { "data-item-type": "task", "data-checked": String(checked) } : {}),
        // Counting starts again here (see style.css).
        ...(start != null ? { style: `counter-reset: page-ol ${start - 1}` } : {}),
      },
      0,
    ];
  },
  parseMarkdown: {
    match: ({ type }) => type === "list" || type === "listItem",
    runner: (state, node, type) => {
      // A list is just its items.
      if (node.type === "list") {
        state.next(node.children);
        return;
      }
      const item = node as typeof node & ListItemNotes & { checked?: boolean | null; spread?: boolean };
      state.openNode(type, {
        listType: item.listType ?? "bullet",
        checked: item.checked ?? null,
        start: item.restart ?? null,
        spread: !!item.spread,
        loose: !!item.loose,
      });
      state.next(node.children);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "list_item",
    runner: (state, node) => {
      const { listType, checked, start, spread, loose } = node.attrs;
      // A list of one; `joinLists` joins it with its neighbours.
      state.openNode("list", undefined, { ordered: listType === "ordered", start: start ?? undefined, spread: loose });
      state.openNode("listItem", undefined, { spread, ...(checked != null ? { checked } : {}) });
      state.next(node.content);
      state.closeNode();
      state.closeNode();
    },
  },
}));

/** What an item read from Markdown needs to know about its list. */
interface ListItemNotes {
  listType?: ListType;
  loose?: boolean;
  /** The number a numbered list starts at, on its first item, when counting on wouldn't give it. */
  restart?: number | null;
}

interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
  ordered?: boolean | null;
  start?: number | null;
  spread?: boolean | null;
}

/** Notes on each item what it needs from its list (see `ListItemNotes`). */
export function noteListItems(node: MarkdownNode): void {
  const children = node.children ?? [];
  children.forEach((child, index) => {
    if (child.type === "list") {
      const start = child.start ?? 1;
      const before = children[index - 1];
      // Numbering would count on from a numbered list right before it.
      const restart = child.ordered && (start !== 1 || (before?.type === "list" && before.ordered)) ? start : null;
      child.children?.forEach((item, i) => {
        Object.assign(item, {
          listType: child.ordered ? "ordered" : "bullet",
          loose: !!child.spread,
          restart: i === 0 ? restart : null,
        } satisfies ListItemNotes);
      });
    }
    noteListItems(child);
  });
}

export const remarkListItems = $remark("pageListItems", () => () => (tree) => noteListItems(tree as MarkdownNode));

/**
 * Joins lists side by side into one, as Markdown has them: bullets with
 * bullets, and numbered items with the numbered list before them unless
 * they start counting again.
 */
export function joinLists(node: MarkdownNode): void {
  if (!node.children) return;
  const joined: MarkdownNode[] = [];
  for (const child of node.children) {
    joinLists(child);
    const last = joined.at(-1);
    if (last?.type === "list" && child.type === "list" && !!last.ordered === !!child.ordered && !(child.ordered && child.start != null)) {
      last.children!.push(...child.children!);
      last.spread = !!last.spread || !!child.spread;
      continue;
    }
    joined.push(child);
  }
  node.children = joined;
}

/** Makes the serializer join lists (see `joinLists`), for saving and for copying as text. */
export const joinListsOnSave: MilkdownPlugin = (ctx) => async () => {
  await ctx.wait(SerializerReady);
  const schema = ctx.get(schemaCtx);
  const remark = ctx.get(remarkCtx);
  ctx.set(serializerCtx, (doc: Node) => {
    const state = new SerializerState(schema);
    state.run(doc);
    const tree = state.build() as MarkdownNode;
    joinLists(tree);
    return remark.stringify(tree as Parameters<typeof remark.stringify>[0]);
  });
};

// --- Where the cursor is ------------------------------------------------------

export const isItem = (node: Node | null | undefined): boolean => node?.type.name === "list_item";

/** The list item whose own line (its first paragraph) the selection is in. */
export function itemAtCursor(state: EditorState): Block | null {
  const { $from } = state.selection;
  if (state.selection instanceof NodeSelection || $from.depth < 2) return null;
  const item = $from.node(-1);
  if (!isItem(item) || $from.index(-1) !== 0) return null;
  return { pos: $from.before(-1), node: item };
}

/** The block Tab and Shift-Tab act on: the selected block, the item whose line the cursor is in, or the text block it's in. */
function cursorBlock(state: EditorState): Block | null {
  const { selection } = state;
  if (selection instanceof NodeSelection) return blockStartingAt(state.doc, selection.from);
  const item = itemAtCursor(state);
  if (item) return item;
  const { $from } = selection;
  return $from.depth > 0 ? blockStartingAt(state.doc, $from.before()) : null;
}

/** Attributes for an item added after `item`: the same kind, unticked, counting on. */
export function nextItemAttrs(item: Node): Attrs {
  return { ...item.attrs, checked: item.attrs.checked != null ? false : null, start: null };
}

/** The selection after `block` moved from `from` to `to`, unchanged inside it. */
function movedSelection(selection: Selection, doc: Node, from: number, to: number): Selection {
  if (selection instanceof NodeSelection) return NodeSelection.create(doc, to);
  return TextSelection.create(doc, selection.anchor - from + to, selection.head - from + to);
}

// --- Commands -----------------------------------------------------------------

/** The item's line becomes text, in place; what's nested in it stays where it is. */
export function itemToText(state: EditorState): Transaction | null {
  const item = itemAtCursor(state);
  if (!item) return null;
  const tr = state.tr.replaceWith(item.pos, item.pos + item.node.nodeSize, item.node.content);
  const { anchor, head } = state.selection;
  return tr.setSelection(TextSelection.create(tr.doc, anchor - 1, head - 1));
}

/** Tab: the block goes into the list item right before it, as its last nested block. */
export const indent: Command = (state, dispatch) => {
  const block = cursorBlock(state);
  if (!block) return false;
  const $pos = state.doc.resolve(block.pos);
  const before = $pos.nodeBefore;
  if (!isItem(before)) return isItem(block.node); // an item that can't go further in: still handled
  if (dispatch) {
    const to = block.pos - 1; // the end of the item before
    const tr = state.tr.delete(block.pos, block.pos + block.node.nodeSize).insert(to, block.node);
    dispatch(tr.setSelection(movedSelection(state.selection, tr.doc, block.pos, to)).scrollIntoView());
  }
  return true;
};

/**
 * Shift-Tab: the block comes out of the list item it's in, to right after
 * it. The blocks after it in that item come along: nested in it when it's an
 * item, so nothing changes order.
 */
export const outdent: Command = (state, dispatch) => {
  const block = cursorBlock(state);
  if (!block) return false;
  const $pos = state.doc.resolve(block.pos);
  const parent = $pos.parent;
  if (!isItem(parent)) return isItem(block.node);
  if (dispatch) {
    const following = parent.content.cut(block.pos + block.node.nodeSize - $pos.start());
    const moved = isItem(block.node)
      ? [block.node.copy(block.node.content.append(following))]
      : [block.node, ...nodesOf(following)];
    const end = $pos.end();
    const tr = state.tr.delete(block.pos, end);
    const to = block.pos + 1; // right after the item, which now ends at block.pos
    tr.insert(to, moved);
    dispatch(tr.setSelection(movedSelection(state.selection, tr.doc, block.pos, to)).scrollIntoView());
  }
  return true;
};

function nodesOf(fragment: { forEach(f: (node: Node) => void): void }): Node[] {
  const nodes: Node[] = [];
  fragment.forEach((node) => nodes.push(node));
  return nodes;
}

/**
 * Enter on an item's line: a new item after it (or, at the end of an item
 * with blocks nested in it, the first of those, as in Notion). On an empty
 * item: out one level, or into text at the top level.
 */
const enter: Command = (state, dispatch) => {
  const { selection } = state;
  const item = itemAtCursor(state);
  if (!item || !(selection instanceof TextSelection) || selection.$from.parent !== selection.$to.parent) return false;
  if (selection.$from.parent.content.size === 0) {
    if (isItem(state.doc.resolve(item.pos).parent)) return outdent(state, dispatch);
    const tr = itemToText(state);
    if (tr) dispatch?.(tr.scrollIntoView());
    return !!tr;
  }
  if (!dispatch) return true;
  const type = item.node.type;
  const attrs = nextItemAttrs(item.node);
  const paragraph = state.schema.nodes.paragraph;
  const tr = state.tr.deleteSelection();
  const $pos = tr.selection.$from;
  if ($pos.parentOffset === 0) {
    // At the start: an empty item above, and the cursor stays with the text.
    tr.insert(item.pos, type.create(attrs, paragraph.create()));
  } else if ($pos.parentOffset === $pos.parent.content.size && item.node.childCount > 1) {
    const at = $pos.after();
    tr.insert(at, type.create(attrs, paragraph.create()));
    tr.setSelection(TextSelection.create(tr.doc, at + 2));
  } else {
    tr.split($pos.pos, 2, [{ type, attrs }]);
  }
  dispatch(tr.scrollIntoView());
  return true;
};

/** Backspace at the start of an item's line: it becomes text, in place. */
const backspace: Command = (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty || selection.$from.parentOffset !== 0) return false;
  const tr = itemToText(state);
  if (tr) dispatch?.(tr);
  return !!tr;
};

export const listKeymap = $useKeymap("pageLists", {
  NewItem: { shortcuts: "Enter", priority: 60, command: () => enter },
  ToText: { shortcuts: "Backspace", priority: 60, command: () => backspace },
  Indent: { shortcuts: ["Tab", "Mod-]"], priority: 60, command: () => indent },
  Outdent: { shortcuts: ["Shift-Tab", "Mod-["], priority: 60, command: () => outdent },
});

/**
 * Makes the block the cursor is in a list item of `listType` (and a to-do
 * with `task`): an item changes in place; a paragraph or heading becomes an
 * item's line. Null when the cursor's block can't be one.
 */
export function setListType(state: EditorState, listType: ListType | null, task: boolean): Transaction | null {
  const item = itemAtCursor(state);
  if (item) {
    const checked = task ? (item.node.attrs.checked ?? false) : null;
    return state.tr.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, listType: listType ?? item.node.attrs.listType, checked });
  }
  const { $from } = state.selection;
  const block = $from.parent;
  if (!block.isTextblock || block.type.spec.code || $from.depth < 1) return null;
  const tr = state.tr;
  if (block.type !== state.schema.nodes.paragraph) tr.setBlockType($from.before(), $from.after(), state.schema.nodes.paragraph);
  return wrapInItem(tr, $from.before(), { listType: listType ?? "bullet", checked: task ? false : null });
}

/** Wraps the paragraph starting at `pos` in a list item. Null when it can't be one there (a table cell). */
function wrapInItem(tr: Transaction, pos: number, attrs: Attrs): Transaction | null {
  const type: NodeType = tr.doc.type.schema.nodes.list_item;
  const range = tr.doc.resolve(pos + 1).blockRange();
  const wrapping = range && findWrapping(range, type, attrs);
  if (!range || !wrapping) return null;
  return tr.wrap(range, wrapping);
}

// --- Typing Markdown ------------------------------------------------------------

/**
 * Typing a list marker at the start of a paragraph: "- " (or * or +), "1. "
 * and "[ ] " / "[x] ". On an item's line, "[ ] " makes it a to-do.
 */
function markerRule(pattern: RegExp, attrs: (match: RegExpMatchArray) => { listType?: ListType; checked?: boolean; start?: number | null }) {
  return new InputRule(pattern, (state, match, start, end) => {
    const $start = state.doc.resolve(start);
    if ($start.parent.type.name !== "paragraph") return null;
    const wanted = attrs(match);
    const item = isItem($start.node(-1)) && $start.index(-1) === 0 ? $start.node(-1) : null;
    if (item) {
      if (wanted.checked == null || item.attrs.checked != null) return null;
      return state.tr.delete(start, end).setNodeMarkup($start.before(-1), undefined, { ...item.attrs, checked: wanted.checked });
    }
    const tr = state.tr.delete(start, end);
    return wrapInItem(tr, $start.before(), { listType: "bullet", checked: null, start: null, ...wanted });
  });
}

export const listInputRules = [
  $inputRule(() => markerRule(/^\s*[-+*]\s$/, () => ({ listType: "bullet" }))),
  $inputRule(() =>
    markerRule(/^(\d+)[.)]\s$/, (m) => {
      const n = Number(m[1]);
      return { listType: "ordered", start: n === 1 ? null : n };
    }),
  ),
  $inputRule(() => markerRule(/^\[( |x|X)?\]\s$/, (m) => ({ checked: m[1] === "x" || m[1] === "X" }))),
];

export const lists: MilkdownPlugin[] = [listItemSchema, remarkListItems, joinListsOnSave, listKeymap, ...listInputRules].flat();
