// Blocks, as in Notion: each top-level element of the page is a block, and so
// is each block nested in a list item (lists.ts) or a toggle (toggles.ts),
// list items and toggles included. These
// are the operations on them the block handle, its menu and the keyboard
// use: find the block at a position, select, delete, duplicate, move (by a
// step, or to where it was dragged) and add a new one. Free of any UI
// framework, so it's tested without a browser.
import type { Node, ResolvedPos } from "@milkdown/kit/prose/model";
import { type Command, type EditorState, NodeSelection, Plugin, PluginKey, type Selection, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";

export interface Block {
  /** Document position just before the block. */
  pos: number;
  node: Node;
}

const isListItem = (node: Node | null | undefined) => node?.type.name === "list_item";

/**
 * A block with a line of its own (its first child) and blocks nested under
 * it: a list item, or a toggle (its heading, and what folds under it).
 */
export const isContainer = (node: Node | null | undefined): boolean =>
  node?.type.name === "list_item" || node?.type.name === "toggle";

/**
 * Whether a child of `parent` at `index` is a block: anything at the top
 * level, and anything nested in a container except its own line.
 */
const holdsBlock = (parent: Node, index: number) => parent.type.name === "doc" || (isContainer(parent) && index > 0);

/** The container (list item or toggle) whose own line the selection is in. */
export function lineOwnerAtCursor(state: EditorState): Block | null {
  const { $from } = state.selection;
  if (state.selection instanceof NodeSelection || $from.depth < 2) return null;
  const owner = $from.node(-1);
  if (!isContainer(owner) || $from.index(-1) !== 0) return null;
  return { pos: $from.before(-1), node: owner };
}

/** Whether the toggle at a position is closed, for code that only has the document (see toggles.ts). */
export type IsFolded = (pos: number) => boolean;
const NOTHING_FOLDED: IsFolded = () => false;

/** The block `$pos` is in: the innermost one (see `holdsBlock`). */
function blockAtResolved($pos: ResolvedPos): Block | null {
  for (let depth = $pos.depth; depth > 0; depth--) {
    if (holdsBlock($pos.node(depth - 1), $pos.index(depth - 1))) return { pos: $pos.before(depth), node: $pos.node(depth) };
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
  const $pos = doc.resolve(pos);
  const node = $pos.nodeAfter;
  return node && holdsBlock($pos.parent, $pos.index()) ? { pos, node } : null;
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

/** A text cursor near `pos`, or a node selection when there's no text there. */
function selectionNear(doc: Node, pos: number, bias: -1 | 1 = 1): Selection {
  return TextSelection.findFrom(doc.resolve(Math.min(pos, doc.content.size)), bias, true) ??
    TextSelection.findFrom(doc.resolve(Math.min(pos, doc.content.size)), -bias as -1 | 1, true) ??
    NodeSelection.create(doc, 0);
}

export function deleteBlock(state: EditorState, block: Block): Transaction {
  const from = block.pos;
  const to = block.pos + block.node.nodeSize;
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
  // A numbered item's copy counts on from it.
  const copy = isListItem(block.node) ? block.node.type.create({ ...block.node.attrs, start: null }, block.node.content) : block.node;
  const tr = state.tr.insert(end, copy);
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
 * Moves the block one step up or down among its siblings (⌘⇧↑ / ⌘⇧↓): the
 * blocks at the top level, or those nested in the same list item. Null
 * when there's nowhere to go. The selection moves with the block.
 */
export function moveBlockStep(state: EditorState, block: Block, direction: -1 | 1): Transaction | null {
  const $pos = state.doc.resolve(block.pos);
  const sibling = $pos.index() + direction;
  if (sibling < 0 || sibling >= $pos.parent.childCount || !holdsBlock($pos.parent, sibling)) return null;
  const other = $pos.parent.child(sibling);
  const to = direction < 0 ? block.pos - other.nodeSize : block.pos + other.nodeSize;
  const tr = state.tr.delete(block.pos, block.pos + block.node.nodeSize).insert(to, block.node);
  return tr.setSelection(shifted(state.selection, tr.doc, block, to)).scrollIntoView();
}

/**
 * Moves `block` to document position `target`, a position between blocks
 * (from `dropTargets`). The moved block ends up selected. Null when nothing
 * would change.
 */
export function moveBlockTo(state: EditorState, block: Block, target: number): Transaction | null {
  const from = block.pos;
  const to = block.pos + block.node.nodeSize;
  if (target >= from && target <= to) return null;
  const tr = state.tr.insert(target, block.node);
  tr.delete(tr.mapping.map(from, 1), tr.mapping.map(to, -1));
  const moved = tr.mapping.slice(1).map(target, 1);
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
    ? schema.nodes.list_item.create({ ...node.attrs, checked: node.attrs.checked != null ? false : null, start: null }, paragraph)
    : paragraph;
  const at = above ? block.pos : block.pos + node.nodeSize;
  tr.insert(at, newNode);
  const cursor = at + (isListItem(node) ? 2 : 1) + text.length;
  return tr.setSelection(TextSelection.create(tr.doc, cursor)).scrollIntoView();
}

/**
 * Clicking below the last block, as in Notion: a cursor in an empty
 * paragraph at the end of the page. The last block is reused when it's an
 * empty paragraph already, so clicking twice doesn't pile them up.
 */
export function continueAtEnd(state: EditorState): Transaction {
  const { doc, schema } = state;
  const last = doc.lastChild;
  const tr = state.tr;
  if (last?.type.name === "paragraph" && last.content.size === 0) {
    return tr.setSelection(TextSelection.create(doc, doc.content.size - 1)).scrollIntoView();
  }
  tr.insert(doc.content.size, schema.nodes.paragraph.create());
  return tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1)).scrollIntoView();
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

/**
 * A place a block can be dropped: between two blocks, at one nesting level.
 * The line showing it is drawn at the top or bottom of `block`'s line, from
 * the left of the text at that level.
 */
export interface DropTarget {
  /** Document position the block would go to. */
  pos: number;
  /** The block under the pointer, and which half of its line. */
  block: Block;
  side: "before" | "after";
  /** The container (list item or toggle) the block would be nested in, or null for the top level. */
  parent: Block | null;
}

/** The container `pos` is directly inside, if any. */
function parentItem(doc: Node, pos: number): Block | null {
  const $pos = doc.resolve(pos);
  return $pos.depth > 0 && isContainer($pos.parent) ? { pos: $pos.before(), node: $pos.parent } : null;
}

/** A container whose nested blocks show: a list item, or an open toggle. */
const showsNested = (block: Block, folded: IsFolded) => isContainer(block.node) && !folded(block.pos);

/**
 * The places after `block` as a whole, from the deepest out: right after
 * it, and after each list item it's the last block in (the gap below the
 * last item nested in a list's last item closes several levels at once).
 */
function placesAfter(doc: Node, block: Block): DropTarget[] {
  const places: DropTarget[] = [];
  for (let current = block; ; ) {
    const end = current.pos + current.node.nodeSize;
    const parent = parentItem(doc, current.pos);
    places.push({ pos: end, block, side: "after", parent });
    if (!parent || end !== parent.pos + parent.node.nodeSize - 1) return places;
    current = parent;
  }
}

/**
 * The places in the gap below `over`'s line, from the deepest out: nested
 * first in it when it's a list item or an open toggle, then (unless it has
 * blocks nested under that line) after it and each item it closes.
 */
function placesBelowLine(doc: Node, over: Block, folded: IsFolded): DropTarget[] {
  if (!showsNested(over, folded)) return placesAfter(doc, over);
  const nested = { pos: over.pos + 1 + over.node.firstChild!.nodeSize, block: over, side: "after" as const, parent: over };
  return over.node.childCount > 1 ? [nested] : [nested, ...placesAfter(doc, over)];
}

/**
 * The block whose line is right above `block` on screen: the one before it
 * (or the last block shown nested in that, at any depth), or the container
 * it's nested in when it's the first block there. Null for the first block
 * of the page.
 */
function lineAbove(doc: Node, block: Block, folded: IsFolded): Block | null {
  const $pos = doc.resolve(block.pos);
  const index = $pos.index();
  if (index === 0) return null;
  if (isContainer($pos.parent) && index === 1) return { pos: $pos.before(), node: $pos.parent };
  let above: Block = { pos: block.pos - $pos.nodeBefore!.nodeSize, node: $pos.nodeBefore! };
  while (showsNested(above, folded) && above.node.childCount > 1) {
    above = { pos: above.pos + above.node.nodeSize - 1 - above.node.lastChild!.nodeSize, node: above.node.lastChild! };
  }
  return above;
}

/** The places in the gap above `block`'s line: the same gap as below the line above it. */
function placesAbove(doc: Node, block: Block, folded: IsFolded): DropTarget[] {
  const above = lineAbove(doc, block, folded);
  return above ? placesBelowLine(doc, above, folded) : [{ pos: block.pos, block, side: "before", parent: parentItem(doc, block.pos) }];
}

const depthOf = (doc: Node, target: DropTarget) => doc.resolve(target.pos).depth;

/**
 * Where something dropped on the `side` half of `over`'s line can go, one
 * place per nesting level, from the top level in. Each gap between two
 * lines offers the same places from both sides of it, so the line never
 * jumps between two places for the same gap.
 *
 * With `dragged`, the block being moved: over itself (or what's nested in
 * it) it counts as lifted out, so the gaps above and below it are one, and
 * the places offered include moving it out of the item it's in. Places
 * inside it are left out; places right where it is stay, so each level
 * keeps its place in the list (dropping there does nothing).
 *
 * `folded` says which toggles are closed: nothing can be dropped among
 * blocks that don't show.
 */
export function dropTargets(
  doc: Node,
  over: Block,
  side: "before" | "after",
  dragged?: Block,
  folded: IsFolded = NOTHING_FOLDED,
): DropTarget[] {
  let places: DropTarget[];
  const from = dragged?.pos ?? -1;
  const to = dragged ? dragged.pos + dragged.node.nodeSize : -1;
  if (dragged && over.pos >= from && over.pos < to) {
    places = placesAfter(doc, dragged);
    for (const place of placesAbove(doc, dragged, folded)) {
      if (!places.some((p) => p.parent?.pos === place.parent?.pos)) places.push(place);
    }
  } else {
    places = side === "before" ? placesAbove(doc, over, folded) : placesBelowLine(doc, over, folded);
  }
  places = places.filter((p) => p.pos <= from || p.pos >= to);
  return places.sort((a, b) => depthOf(doc, a) - depthOf(doc, b));
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
