import type { EditorView } from "@milkdown/kit/prose/view";
import { type RefObject, useLayoutEffect } from "react";

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

/** A box in window coordinates. */
interface Line {
  left: number;
  top: number;
  bottom: number;
}

/** Where a menu goes in the window, and how tall it may be (null: as tall as it likes). */
export interface Placement {
  left: number;
  top: number;
  maxHeight: number | null;
}

/** Space kept between a menu and the line it belongs to. */
export const MENU_GAP = 6;
/** Space kept between a menu and the window's edges. */
export const WINDOW_MARGIN = 8;

/**
 * Places a menu of `size` for `line`, inside a window of `window`: below
 * the line when it fits, else above when there's more room there, else
 * below and shorter (the menu scrolls). It shifts left when it would run
 * past the right edge. All in window coordinates.
 */
export function placeMenu(
  line: Line,
  size: { width: number; height: number },
  window: { width: number; height: number },
): Placement {
  const roomBelow = window.height - WINDOW_MARGIN - (line.bottom + MENU_GAP);
  const roomAbove = line.top - MENU_GAP - WINDOW_MARGIN;
  const left = Math.max(WINDOW_MARGIN, Math.min(line.left, window.width - WINDOW_MARGIN - size.width));
  if (size.height <= roomBelow) return { left, top: line.bottom + MENU_GAP, maxHeight: null };
  if (roomAbove > roomBelow) {
    const height = Math.min(size.height, roomAbove);
    return { left, top: line.top - MENU_GAP - height, maxHeight: size.height > roomAbove ? roomAbove : null };
  }
  return { left, top: line.bottom + MENU_GAP, maxHeight: Math.max(roomBelow, 0) };
}

/**
 * Keeps the menu in `menu` inside the window, next to position `pos`
 * (see `placeMenu`). Call on every render; `menu` is positioned relative
 * to `container`. It sets the menu's position itself, so don't also give
 * the menu `left` or `top`.
 */
export function useMenuPlacement(menu: RefObject<HTMLElement | null>, view: EditorView, container: RefObject<HTMLElement | null>, pos: number | null) {
  useLayoutEffect(() => {
    const el = menu.current;
    if (!el || !container.current || pos === null) return;
    // Its natural size: offsetWidth and offsetHeight ignore the opening animation's transform.
    el.style.maxHeight = "";
    const at = view.coordsAtPos(pos);
    const place = placeMenu(
      at,
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
    );
    const box = container.current.getBoundingClientRect();
    el.style.left = `${place.left - box.left}px`;
    el.style.top = `${place.top - box.top}px`;
    el.style.maxHeight = place.maxHeight === null ? "" : `${place.maxHeight}px`;
    // Above the line, it opens upwards.
    el.style.setProperty("--page-menu-from", place.top < at.top ? "translateY(-4px)" : "");
  });
}
