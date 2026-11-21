// Blocks, as in Notion: each top-level element of the page is a block, and so
// is each list item (at any depth). These are the operations on them the
// block handle, its menu and the keyboard use: find the block at a position,
// select, delete, duplicate, move (by a step, or to where it was dragged)
// and add a new one. Free of any UI framework, so it's tested without a browser.
import { Fragment, type Node, type ResolvedPos } from "@milkdown/kit/prose/model";
import { type Command, type EditorState, NodeSelection, Plugin, PluginKey, type Selection, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";

export interface Block {
  /** Document position just before the block. */
  pos: number;
  node: Node;
}

const isListItem = (node: Node) => node.type.name === "list_item";
const isList = (node: Node) => node.type.name === "bullet_list" || node.type.name === "ordered_list";

/** The block `$pos` is in: the innermost list item, or else the top-level element. */
function blockAtResolved($pos: ResolvedPos): Block | null {
  // Right before a list item (or after the last one): that item.
  if (isList($pos.parent)) {
    if ($pos.nodeAfter) return { pos: $pos.pos, node: $pos.nodeAfter };
    if ($pos.nodeBefore) return { pos: $pos.pos - $pos.nodeBefore.nodeSize, node: $pos.nodeBefore };
  }
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (isListItem(node) || depth === 1) return { pos: $pos.before(depth), node };
  }
  // Between top-level blocks: the one after.
  const after = $pos.nodeAfter;
  return after ? { pos: $pos.pos, node: after } : null;
}

/** The block containing document position `pos`. */
export function blockAt(doc: Node, pos: number): Block | null {
  if (pos < 0 || pos > doc.content.size) return null;
  return blockAtResolved(doc.resolve(pos));
}

/** The block that starts exactly at `pos`, if any (to check a remembered block still exists). */
export function blockStartingAt(doc: Node, pos: number): Block | null {
  if (pos < 0 || pos >= doc.content.size) return null;
  const node = doc.resolve(pos).nodeAfter;
  if (!node) return null;
  const $pos = doc.resolve(pos);
  if ($pos.depth === 0 || (isListItem(node) && isList($pos.parent))) return { pos, node };
  return null;
}

/** The block the selection is in (or the selected block). */
export function selectedBlock(state: EditorState): Block | null {
  const { selection } = state;
  if (selection instanceof NodeSelection) {
    const found = blockStartingAt(state.doc, selection.from);
    if (found) return found;
  }
  return blockAt(state.doc, selection.from);
}

/** Selects the whole block, as Notion does when you press Esc or open its menu. */
export function selectBlock(state: EditorState, block: Block): Transaction {
  return state.tr.setSelection(NodeSelection.create(state.doc, block.pos));
}

/**
 * The range to remove to take `block` out of the page: a list item that is
 * the only one in its list takes the list with it.
 */
function removalRange(doc: Node, block: Block): { from: number; to: number } {
  const $pos = doc.resolve(block.pos);
  if (isListItem(block.node) && $pos.parent.childCount === 1 && $pos.depth > 0) {
    // The list, and further up while that is the only thing in a list item too.
    return removalRange(doc, { pos: $pos.before(), node: $pos.parent });
  }
  return { from: block.pos, to: block.pos + block.node.nodeSize };
}

/** A text cursor near `pos`, or a node selection when there's no text there. */
function selectionNear(doc: Node, pos: number, bias: -1 | 1 = 1): Selection {
  return TextSelection.findFrom(doc.resolve(Math.min(pos, doc.content.size)), bias, true) ??
    TextSelection.findFrom(doc.resolve(Math.min(pos, doc.content.size)), -bias as -1 | 1, true) ??
    NodeSelection.create(doc, 0);
}

export function deleteBlock(state: EditorState, block: Block): Transaction {
  const { from, to } = removalRange(state.doc, block);
  const tr = state.tr;
  if (from === 0 && to === state.doc.content.size) {
    // The last block on the page: leave an empty line to type in.
    tr.replaceWith(0, to, state.schema.nodes.paragraph.create());
    return tr.setSelection(TextSelection.create(tr.doc, 1));
  }
  tr.delete(from, to);
  // The cursor goes to the end of the block before, as in Notion (or the start of the one after).
  const before = from > 0 ? -1 : 1;
  return tr.setSelection(selectionNear(tr.doc, tr.mapping.map(from), before)).scrollIntoView();
}

/** Inserts a copy of the block after it. The selection moves to the copy. */
export function duplicateBlock(state: EditorState, block: Block): Transaction {
  const end = block.pos + block.node.nodeSize;
  const tr = state.tr.insert(end, block.node);
  return tr.setSelection(shifted(state.selection, tr.doc, block, end)).scrollIntoView();
}

/** The selection inside `block`, moved to the same place in a copy of it starting at `to`. */
function shifted(selection: Selection, doc: Node, block: Block, to: number): Selection {
  if (selection instanceof NodeSelection) return NodeSelection.create(doc, to);
  const start = block.pos;
  const end = block.pos + block.node.nodeSize;
  const inside = (p: number) => p >= start && p <= end;
  if (!inside(selection.anchor) || !inside(selection.head)) return NodeSelection.create(doc, to);
  return TextSelection.create(doc, selection.anchor - start + to, selection.head - start + to);
}

/**
 * Moves the block one step up or down among its siblings (⌘⇧↑ / ⌘⇧↓).
 * Null when there's nowhere to go. The selection moves with the block.
 */
export function moveBlockStep(state: EditorState, block: Block, direction: -1 | 1): Transaction | null {
  const $pos = state.doc.resolve(block.pos);
  const index = $pos.index();
  const parent = $pos.parent;
  const sibling = index + direction;
  if (sibling < 0 || sibling >= parent.childCount) {
    // The first or last item of a list: move the whole list when it's the only item.
    if (isListItem(block.node) && parent.childCount === 1 && $pos.depth > 0) {
      return moveBlockStep(state, { pos: $pos.before(), node: parent }, direction);
    }
    return null;
  }
  const other = parent.child(sibling);
  const tr = state.tr;
  let to: number;
  if (direction < 0) {
    // Take the block out and put it back before its previous sibling.
    to = block.pos - other.nodeSize;
    tr.delete(block.pos, block.pos + block.node.nodeSize).insert(to, block.node);
  } else {
    // Put the block back after its next sibling.
    const end = block.pos + block.node.nodeSize;
    tr.delete(block.pos, end).insert(block.pos + other.nodeSize, block.node);
    to = block.pos + other.nodeSize;
  }
  return tr.setSelection(shifted(state.selection, tr.doc, block, to)).scrollIntoView();
}

/**
 * The block as content that can go at `$at`: as it is, or wrapped in a list
 * (a list item going between blocks), or in a list item (a block going into a
 * list), or as its items (a list going into a list). Null if it can't go there.
 */
function fitAt(block: Block, $at: ResolvedPos, sourceList: Node | null): Fragment | null {
  const { schema } = $at.doc.type;
  const parent = $at.parent;
  const index = $at.index();
  const candidates: Fragment[] = [Fragment.from(block.node)];
  if (isListItem(block.node)) {
    const list = sourceList ?? schema.nodes.bullet_list.create();
    candidates.push(Fragment.from(list.type.create(list.attrs, block.node)));
  } else if (isList(block.node)) {
    candidates.push(block.node.content);
  } else if (isList(parent)) {
    // Next to a to-do, a block becomes a to-do too.
    const neighbour = parent.maybeChild(index) ?? parent.maybeChild(index - 1);
    const checked = neighbour?.attrs.checked != null ? false : null;
    // Only blocks that can start an item (a heading can't: Markdown has no such thing).
    const item = schema.nodes.list_item.create({ ...neighbour?.attrs, checked }, block.node);
    if (item.type.validContent(item.content)) candidates.push(Fragment.from(item));
  }
  return candidates.find((content) => parent.canReplace(index, index, content)) ?? null;
}

/**
 * Where `block` really lands when dropped at `target`, and as what: at
 * `target` if it fits there (see `fitAt`), or else next to the top-level
 * block around `target`, on the nearer side. Null when that changes nothing.
 */
function landing(doc: Node, block: Block, target: number): { pos: number; content: Fragment } | null {
  const { from, to } = removalRange(doc, block);
  // Dropping a block onto itself, or into itself, changes nothing.
  if (target >= from && target <= to) return null;
  const $source = doc.resolve(block.pos);
  const sourceList = isListItem(block.node) && $source.depth > 0 ? $source.parent : null;
  const $at = doc.resolve(target);
  const content = fitAt(block, $at, sourceList);
  if (content) return { pos: target, content };
  if ($at.depth === 0) return null;
  const top = $at.before(1);
  const end = $at.after(1);
  const side = target - top < end - target ? top : end;
  if (side >= from && side <= to) return null;
  const outside = fitAt(block, doc.resolve(side), sourceList);
  return outside && { pos: side, content: outside };
}

/**
 * Moves `block` to document position `target` (a position between blocks,
 * from `dropTarget`), fitting it in as `fitAt` describes. The moved block
 * ends up selected. Null when nothing would change.
 */
export function moveBlockTo(state: EditorState, block: Block, target: number): Transaction | null {
  const land = landing(state.doc, block, target);
  if (!land) return null;
  const { from, to } = removalRange(state.doc, block);
  const tr = state.tr.insert(land.pos, land.content);
  // The moved block starts at the insertion point, or one level in when it was wrapped.
  const wrapped = land.content.firstChild !== block.node && !isList(block.node);
  const movedAt = land.pos + (wrapped ? 1 : 0);
  tr.delete(tr.mapping.map(from, 1), tr.mapping.map(to, -1));
  const moved = tr.mapping.slice(1).map(movedAt, 1);
  return tr.setSelection(NodeSelection.create(tr.doc, moved));
}

/**
 * Adds an empty block after `block` (before it with `above`) and puts the
 * cursor in it. With `text`, the block starts with that text: the "+" next to
 * a block adds "/" so the block menu opens. In a list the new block is a list
 * item, as when pressing Enter. An empty text block is reused instead.
 */
export function insertBlock(state: EditorState, block: Block, { above = false, text = "" } = {}): Transaction {
  const { schema } = state;
  const tr = state.tr;
  const node = block.node;
  const emptyText = node.type.name === "paragraph" && node.content.size === 0;
  const emptyItem = isListItem(node) && node.childCount === 1 && node.firstChild!.content.size === 0;
  if (emptyText || emptyItem) {
    const start = block.pos + (emptyItem ? 2 : 1);
    if (text) tr.insertText(text, start);
    return tr.setSelection(TextSelection.create(tr.doc, start + text.length)).scrollIntoView();
  }
  const paragraph = schema.nodes.paragraph.create(null, text ? schema.text(text) : null);
  const newNode = isListItem(node)
    ? schema.nodes.list_item.create({ ...node.attrs, checked: node.attrs.checked != null ? false : null }, paragraph)
    : paragraph;
  const at = above ? block.pos : block.pos + node.nodeSize;
  tr.insert(at, newNode);
  const cursor = at + (isListItem(node) ? 2 : 1) + text.length;
  return tr.setSelection(TextSelection.create(tr.doc, cursor)).scrollIntoView();
}

/** Puts a text cursor inside `block` (at the end of its first line of text), for "Turn into". */
export function focusBlock(state: EditorState, block: Block, at: "start" | "end" = "end"): Transaction | null {
  let textblock: number | null = null;
  block.node.descendants((child, offset) => {
    if (textblock !== null) return false;
    if (child.isTextblock) {
      textblock = block.pos + 1 + offset + 1 + (at === "end" ? child.content.size : 0);
      return false;
    }
    return true;
  });
  if (block.node.isTextblock) textblock = block.pos + 1 + (at === "end" ? block.node.content.size : 0);
  if (textblock === null) return null;
  return state.tr.setSelection(TextSelection.create(state.doc, textblock));
}

// --- Drag and drop --------------------------------------------------------

export interface DropTarget {
  /** Document position the block would go to. */
  pos: number;
  /** The block the line is drawn next to, and on which side. */
  block: Block;
  side: "before" | "after";
}

/**
 * Where a dragged block lands when the pointer is over `over` (the block
 * under it, from `blockAt`), in the `side` half of it. Null when the drop
 * wouldn't move anything.
 */
export function dropTarget(doc: Node, dragged: Block, over: Block, side: "before" | "after"): DropTarget | null {
  const { from, to } = removalRange(doc, dragged);
  // Over the dragged block itself, or inside it.
  if (over.pos >= from && over.pos < to) return null;
  const land = landing(doc, dragged, side === "before" ? over.pos : over.pos + over.node.nodeSize);
  if (!land) return null;
  // The line goes where the block really lands, which may be outside a list.
  const $land = doc.resolve(land.pos);
  if ($land.nodeAfter) return { pos: land.pos, block: { pos: land.pos, node: $land.nodeAfter }, side: "before" };
  const before = $land.nodeBefore!;
  return { pos: land.pos, block: { pos: land.pos - before.nodeSize, node: before }, side: "after" };
}

// --- The block being dragged, shown faded ---------------------------------

export const blockStateKey = new PluginKey<{ dragging: number | null }>("page-blocks");

/** Marks a block as being dragged (or none with null), so it shows faded. */
export function setDragging(tr: Transaction, pos: number | null): Transaction {
  return tr.setMeta(blockStateKey, { dragging: pos });
}

export function blockStatePlugin(): Plugin {
  return new Plugin({
    key: blockStateKey,
    state: {
      init: () => ({ dragging: null as number | null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(blockStateKey) as { dragging: number | null } | undefined;
        if (meta) return meta;
        if (value.dragging === null || !tr.docChanged) return value;
        const mapped = tr.mapping.mapResult(value.dragging, 1);
        return { dragging: mapped.deleted ? null : mapped.pos };
      },
    },
    props: {
      decorations(state) {
        const { dragging } = blockStateKey.getState(state)!;
        const block = dragging === null ? null : blockStartingAt(state.doc, dragging);
        if (!block) return null;
        return DecorationSet.create(state.doc, [
          Decoration.node(block.pos, block.pos + block.node.nodeSize, { class: "page-block-dragging" }),
        ]);
      },
    },
  });
}

// --- Keys -----------------------------------------------------------------

const onBlock = (run: (state: EditorState, block: Block) => Transaction | null): Command =>
  (state, dispatch) => {
    const block = selectedBlock(state);
    if (!block) return false;
    const tr = run(state, block);
    if (!tr) return true; // nowhere to move: still handled, so the key does nothing else
    dispatch?.(tr);
    return true;
  };

const blockSelected = (state: EditorState): Block | null =>
  state.selection instanceof NodeSelection ? blockStartingAt(state.doc, state.selection.from) : null;

/**
 * Keys for blocks, as in Notion: Esc selects the block the cursor is in;
 * with a block selected, Backspace or Delete removes it and Enter goes back
 * to editing its text; ⌘D duplicates and ⌘⇧↑ / ⌘⇧↓ move the block.
 */
export const BLOCK_KEYS: Record<string, Command> = {
  Escape: (state, dispatch) => {
    if (state.selection instanceof NodeSelection) return false;
    const block = selectedBlock(state);
    if (!block) return false;
    dispatch?.(selectBlock(state, block));
    return true;
  },
  Backspace: (state, dispatch) => {
    const block = blockSelected(state);
    if (!block) return false;
    dispatch?.(deleteBlock(state, block));
    return true;
  },
  Delete: (state, dispatch) => BLOCK_KEYS.Backspace(state, dispatch),
  Enter: (state, dispatch) => {
    const block = blockSelected(state);
    if (!block) return false;
    const tr = focusBlock(state, block);
    if (!tr) return false;
    dispatch?.(tr);
    return true;
  },
  "Mod-d": onBlock(duplicateBlock),
  "Mod-Shift-ArrowUp": onBlock((state, block) => moveBlockStep(state, block, -1)),
  "Mod-Shift-ArrowDown": onBlock((state, block) => moveBlockStep(state, block, 1)),
};
