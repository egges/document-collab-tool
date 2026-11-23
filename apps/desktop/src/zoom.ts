// Zooming the whole window in and out, as in a browser: ⌘+ / ⌘− / ⌘0 (Ctrl
// elsewhere). The level is kept per device, like the sidebar's width.
//
// What's in the title bar zooms too, as in Notion. On macOS the window's own
// buttons don't, and stay where they are, so the bar keeps its height and the
// room for them the same on screen, with its contents centred on them. The
// styles do that with `--chrome-zoom` (see app.css).
import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { errorText } from "./api.ts";
import { log } from "./devlog.ts";
import { isMac } from "./shortcuts.ts";

/** The steps browsers use. */
export const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

const KEY = "zoom";

export type ZoomKey = "in" | "out" | "reset";

/**
 * Which zoom key `event` is, if any. By character and by physical key, so it
 * works on any keyboard layout, with or without Shift (⌘= and ⌘+ both zoom
 * in) and on the number pad.
 */
export function zoomKey(event: KeyboardEvent, mac = isMac): ZoomKey | null {
  const mod = mac ? event.metaKey : event.ctrlKey;
  if (!mod || event.altKey || (mac ? event.ctrlKey : event.metaKey)) return null;
  const { key, code } = event;
  if (key === "+" || key === "=" || code === "Equal" || code === "NumpadAdd") return "in";
  if (key === "-" || key === "_" || code === "Minus" || code === "NumpadSubtract") return "out";
  if (!event.shiftKey && (key === "0" || code === "Digit0" || code === "Numpad0")) return "reset";
  return null;
}

/** The level after pressing `key` at `level`. */
export function nextZoom(level: number, key: ZoomKey): number {
  if (key === "reset") return 1;
  if (key === "in") return ZOOM_LEVELS.find((l) => l > level + 0.001) ?? ZOOM_LEVELS.at(-1)!;
  return [...ZOOM_LEVELS].reverse().find((l) => l < level - 0.001) ?? ZOOM_LEVELS[0];
}

function saved(): number {
  try {
    const level = Number(localStorage.getItem(KEY));
    return ZOOM_LEVELS.includes(level as (typeof ZOOM_LEVELS)[number]) ? level : 1;
  } catch {
    return 1;
  }
}

let level = 1;
const listeners = new Set<(level: number) => void>();

async function apply() {
  document.documentElement.style.setProperty("--chrome-zoom", String(1 / level));
  if (!("__TAURI_INTERNALS__" in window)) return;
  try {
    await getCurrentWebview().setZoom(level);
  } catch (e) {
    log("warn", "ui", `Couldn't zoom to ${level}: ${errorText(e)}`);
  }
}

/** Zoom by a key's step (as ⌘+ / ⌘− / ⌘0 do), and keep the level for next time. */
export function zoom(key: ZoomKey) {
  const next = nextZoom(level, key);
  if (next === level) return;
  level = next;
  void apply();
  listeners.forEach((f) => f(level));
  try {
    localStorage.setItem(KEY, String(level));
  } catch {
    // Not kept: it resets on the next start, nothing worse.
  }
}

/** The current level, kept up to date (for Settings). */
export function useZoom(): number {
  const [now, setNow] = useState(level);
  useEffect(() => {
    listeners.add(setNow);
    setNow(level);
    return () => void listeners.delete(setNow);
  }, []);
  return now;
}

/** Restores the saved level and listens for the keys. Only in the app. */
export function setUpZoom() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  level = saved();
  if (level !== 1) void apply();

  window.addEventListener(
    "keydown",
    (event) => {
      const key = zoomKey(event);
      if (!key) return;
      event.preventDefault();
      event.stopPropagation();
      zoom(key);
    },
    // Before the editor and the app's other shortcuts.
    true,
  );
}
