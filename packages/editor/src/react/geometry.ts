// Where blocks are on screen: the block under the pointer, and its element.
// Shared by the block handle (dragging blocks) and file drops.
import type { EditorView } from "@milkdown/kit/prose/view";
import { type Block, type DropTarget, blockAt, dropTargets } from "../blocks.ts";

/** How far left of the text the handle still shows (the gutter it sits in). */
export const GUTTER = 72;
/** A list item's handle goes left of its bullet or checkbox. */
export const MARKER = 22;

/** How much further right than an item's text the pointer goes to nest a dropped block in it. */
export const NEST_STEP = 40;

/**
 * The block at height `y`: the top-level block there or, below a list
 * item's line, the innermost block nested in it there. Goes by height only,
 * so the gutter (where the handle is) counts as part of the block, and the
 * space between blocks goes to the nearer one.
 */
export function blockAtY(view: EditorView, y: number): Block | null {
  let children = childBlocks(view, view.state.doc, 0);
  let found: Block | null = null;
  while (children.length) {
    const child = nearest(view, children, y);
    if (!child) break;
    found = child;
    if (child.node.type.name !== "list_item" || child.node.childCount < 2) break;
    const line = lineRect(view, child);
    if (!line || y <= line.bottom) break;
    children = childBlocks(view, child.node, child.pos + 1).slice(1);
  }
  return found;
}

/** Where a block's own line is: a list item's first paragraph, or the whole block. */
export function lineRect(view: EditorView, block: Block): DOMRect | null {
  if (block.node.type.name === "list_item") {
    const line = view.nodeDOM(block.pos + 1);
    if (line instanceof HTMLElement) return line.getBoundingClientRect();
  }
  return rectOf(view, block);
}

/** Where text starts at a nesting level: in list item `parent`, or at the top level. */
export function levelLeft(view: EditorView, parent: Block | null): number {
  const line = parent && view.nodeDOM(parent.pos + 1);
  return (line instanceof HTMLElement ? line : view.dom).getBoundingClientRect().left;
}

/**
 * Picks one of `targets` (from `dropTargets`, the top level first) by the
 * pointer's x, given where each level's text starts (`lefts`): the deepest
 * level that starts left of the pointer. Nesting in the item under the
 * pointer takes going `NEST_STEP` into its text. Left of them all, the top.
 */
export function pickTarget(targets: DropTarget[], lefts: number[], x: number): DropTarget | null {
  let chosen = targets[0] ?? null;
  targets.forEach((target, i) => {
    const nests = target.side === "after" && target.parent?.pos === target.block.pos;
    if (x >= lefts[i] + (nests ? NEST_STEP : 0)) chosen = target;
  });
  return chosen;
}

/** Where something dropped at (x, y) goes; `dragged` is the block being moved, if it's one. */
export function dropTargetAt(view: EditorView, x: number, y: number, dragged?: Block): DropTarget | null {
  const over = blockFromPoint(view, x, y);
  const line = over && lineRect(view, over);
  if (!over || !line) return null;
  const side = y < line.top + line.height / 2 ? "before" : "after";
  const targets = dropTargets(view.state.doc, over, side, dragged);
  const target = pickTarget(targets, targets.map((t) => levelLeft(view, t.parent)), x);
  // Right where it is already: no line.
  if (target && dragged && (target.pos === dragged.pos || target.pos === dragged.pos + dragged.node.nodeSize)) return null;
  return target;
}

export function childBlocks(view: EditorView, parent: Block["node"], start: number): Block[] {
  const blocks: Block[] = [];
  parent.forEach((node, offset) => blocks.push({ node, pos: start + offset }));
  return blocks;
}

export function rectOf(view: EditorView, block: Block): DOMRect | null {
  const element = blockElement(view, block);
  return element ? element.getBoundingClientRect() : null;
}

/** The block among `blocks` (in order, top to bottom) containing `y`, or the nearest one. Binary search. */
export function nearest(view: EditorView, blocks: Block[], y: number): Block | null {
  let lo = 0;
  let hi = blocks.length - 1;
  // The last block starting above y.
  let index = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const rect = rectOf(view, blocks[mid]);
    if (rect && rect.top <= y) {
      index = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const rect = rectOf(view, blocks[index]);
  const next = blocks[index + 1] && rectOf(view, blocks[index + 1]);
  if (rect && next && y > rect.bottom && next.top - y < y - rect.bottom) return blocks[index + 1];
  return blocks[index];
}

/** The block under a point (see `blockAtY`); hit-tests where layout can't be measured (tests). */
export function blockFromPoint(view: EditorView, x: number, y: number): Block | null {
  const box = view.dom.getBoundingClientRect();
  if (box.height > 0) return blockAtY(view, Math.min(Math.max(y, box.top + 1), box.bottom - 1));
  let hit: { pos: number; inside: number } | null = null;
  try {
    hit = view.posAtCoords({ left: x, top: y });
  } catch {
    // no layout at all
  }
  return hit ? blockAt(view.state.doc, hit.inside >= 0 ? hit.inside : hit.pos) : blockAtY(view, y);
}

export function blockElement(view: EditorView, block: Block): HTMLElement | null {
  const dom = view.nodeDOM(block.pos);
  return dom instanceof HTMLElement ? dom : null;
}
