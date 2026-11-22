// Small pieces shared by the app's own pop-up menus.
import { type KeyboardEvent, type RefObject, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";

/** The item to move to from `current` (-1 for none) with the arrow keys, wrapping around. */
export function menuStep(current: number, by: 1 | -1, count: number): number {
  if (count === 0) return -1;
  if (current < 0) return by > 0 ? 0 : count - 1;
  return (current + by + count) % count;
}

/** Arrow keys, Home and End move between a menu's enabled items. */
export function onMenuKeyDown(e: KeyboardEvent<HTMLElement>) {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)")];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === "ArrowDown"
      ? menuStep(at, 1, items.length)
      : e.key === "ArrowUp"
        ? menuStep(at, -1, items.length)
        : e.key === "Home"
          ? 0
          : e.key === "End"
            ? items.length - 1
            : null;
  if (next === null) return;
  e.preventDefault();
  items[next]?.focus();
}

/** Close a menu on Escape or a click outside `ref`. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [ref, open, close]);
}

/** Ask for a folder, starting in `start` if given; null when the user cancels. */
export async function pickFolder(title: string, start?: string): Promise<string | null> {
  const path = await open({ directory: true, title, defaultPath: start });
  return typeof path === "string" ? path : null;
}
