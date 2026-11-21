import type { EditorView } from "@milkdown/kit/prose/view";

/** Where a menu goes, in pixels relative to the editor's container. */
export interface MenuPosition {
  left: number;
  top: number;
}

/** Centred above the range `from`–`to` (for the selection toolbar). */
export function above(view: EditorView, container: HTMLElement, from: number, to: number): MenuPosition {
  const box = container.getBoundingClientRect();
  const start = view.coordsAtPos(from);
  const end = view.coordsAtPos(to);
  // On a multi-line selection, centre over the first line.
  const sameLine = Math.abs(start.top - end.top) < 4;
  const centre = sameLine ? (start.left + end.left) / 2 : start.left;
  return { left: centre - box.left, top: Math.min(start.top, end.top) - box.top };
}

/** Just below position `pos`, left-aligned (for the slash menu). */
export function below(view: EditorView, container: HTMLElement, pos: number): MenuPosition {
  const box = container.getBoundingClientRect();
  const at = view.coordsAtPos(pos);
  return { left: at.left - box.left, top: at.bottom - box.top };
}
