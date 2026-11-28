// Keyboard shortcuts: one list, so menus, tooltips and the ⌘/ overview all
// show the same keys. "mod" is ⌘ on macOS and Ctrl elsewhere.

import { useEffect, useRef } from "react";

export const SHORTCUTS = {
  search: { keys: "mod+k", label: "Search" },
  toggleSidebar: { keys: "mod+\\", label: "Show or hide the sidebar" },
  newPage: { keys: "mod+n", label: "New page" },
  newSubpage: { keys: "mod+shift+n", label: "New page inside this one" },
  previousPage: { keys: "mod+alt+arrowup", label: "Previous page" },
  nextPage: { keys: "mod+alt+arrowdown", label: "Next page" },
  deletePage: { keys: "mod+shift+backspace", label: "Delete page" },
  syncNow: { keys: "mod+s", label: "Save and sync now" },
  showShortcuts: { keys: "mod+/", label: "Keyboard shortcuts" },
  openSettings: { keys: "mod+,", label: "Settings" },
  // Handled in zoom.ts, which also takes ⌘= and the number pad.
  zoomIn: { keys: "mod+plus", label: "Zoom in" },
  zoomOut: { keys: "mod+minus", label: "Zoom out" },
  resetZoom: { keys: "mod+0", label: "Actual size" },
  toggleDevPanel: { keys: "mod+j", label: "Developer panel" },
  toggleDevPanelSize: { keys: "mod+shift+j", label: "Developer panel: fill the window" },
  copyLog: { keys: "mod+shift+c", label: "Developer log: copy" },
  filterLog: { keys: "mod+f", label: "Developer log: filter" },
} as const;

export type ShortcutId = keyof typeof SHORTCUTS;

/**
 * Keys in code blocks, handled by the editor; listed in the ⌘/ overview.
 * `typed` is shown as is; `keys` are combinations, as in SHORTCUTS.
 */
export const CODE_BLOCK_KEYS: { label: string; keys?: string[]; typed?: string }[] = [
  { label: "Start a code block", typed: "```" },
  { label: "Indent / outdent", keys: ["tab", "shift+tab"] },
  { label: "Move lines up / down", keys: ["alt+arrowup", "alt+arrowdown"] },
  { label: "Copy lines up / down", keys: ["shift+alt+arrowup", "shift+alt+arrowdown"] },
  { label: "Comment lines out or in", keys: ["mod+/"] },
  { label: "First character of the line", keys: ["home"] },
  { label: "Select the code", keys: ["mod+a"] },
  { label: "Leave the code block", keys: ["mod+enter"] },
];

/** Keys for blocks, handled by the editor; listed in the ⌘/ overview. */
export const BLOCK_KEYS: { label: string; keys: string[] }[] = [
  { label: "Select the block", keys: ["escape"] },
  { label: "Duplicate the block", keys: ["mod+d"] },
  { label: "Move the block up / down", keys: ["mod+shift+arrowup", "mod+shift+arrowdown"] },
  { label: "Delete the selected block", keys: ["backspace"] },
  { label: "Edit the selected block's text", keys: ["enter"] },
  { label: "Open or close a toggle", keys: ["mod+enter"] },
];

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * The key an event is for, by physical key where it matters: with ⌥ held,
 * macOS turns letters into symbols ("∆" for J), so `event.key` won't do.
 */
function keyOf(event: KeyboardEvent): string {
  const { code } = event;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (code === "Slash") return "/";
  if (code === "Backslash") return "\\";
  if (code === "Comma") return ",";
  return event.key.toLowerCase();
}

/** Whether `event` is exactly the combination `keys` (no extra modifiers). */
export function matches(keys: string, event: KeyboardEvent, mac = isMac): boolean {
  const parts = keys.split("+");
  const key = parts.at(-1)!;
  const want = new Set(parts.slice(0, -1));
  const mod = mac ? event.metaKey : event.ctrlKey;
  const otherMod = mac ? event.ctrlKey : event.metaKey;
  return (
    keyOf(event) === key &&
    mod === want.has("mod") &&
    !otherMod &&
    event.shiftKey === want.has("shift") &&
    event.altKey === want.has("alt")
  );
}

const MAC_SYMBOLS: Record<string, string> = {
  mod: "⌘",
  shift: "⇧",
  alt: "⌥",
  backspace: "⌫",
  arrowup: "↑",
  arrowdown: "↓",
  escape: "Esc",
  enter: "↩",
  tab: "⇥",
  home: "Home",
  plus: "+",
  minus: "−",
};

const OTHER_NAMES: Record<string, string> = {
  mod: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  backspace: "Backspace",
  arrowup: "↑",
  arrowdown: "↓",
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  home: "Home",
  plus: "Plus",
  minus: "Minus",
};

/** How to show a combination: "⌘⇧J" on macOS, "Ctrl+Shift+J" elsewhere. */
export function keysLabel(keys: string, mac = isMac): string {
  const names = mac ? MAC_SYMBOLS : OTHER_NAMES;
  const parts = keys.split("+").map((p) => names[p] ?? p.toUpperCase());
  return parts.join(mac ? "" : "+");
}

/** A tooltip such as "Copy (⌘⇧C)". */
export function tip(text: string, id: ShortcutId): string {
  return `${text} (${keysLabel(SHORTCUTS[id].keys)})`;
}

/**
 * Run handlers for shortcuts, wherever the focus is (the editor included).
 * Handlers that are undefined are ignored, so a shortcut only takes effect
 * where it means something. A handler that returns false passes the key on
 * (to the editor, say).
 */
export function useShortcuts(handlers: Partial<Record<ShortcutId, () => void | false>>) {
  const current = useRef(handlers);
  current.current = handlers;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      for (const [id, handler] of Object.entries(current.current)) {
        if (handler && matches(SHORTCUTS[id as ShortcutId].keys, event)) {
          if (handler() === false) return;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
    };
    // Capture, so the editor doesn't swallow them first.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

/** Whether the text cursor is in a code block, where some keys mean what they do in a code editor. */
export function inCodeBlock(): boolean {
  const node = window.getSelection()?.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  return !!element?.closest(".page-code-block pre");
}
