// The app draws its own title bar (TitleBar.tsx). This makes it behave like
// one: pressing on an empty part of it moves the window, and double-clicking
// zooms it. Buttons and other controls inside it keep working.
//
// On macOS the window has no system title bar (tauri.macos.conf.json) and
// its close, minimise and zoom buttons sit over the bar's top left corner,
// so the styles leave room for them, except in full screen, where macOS
// hides them. Elsewhere the system title bar stays.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { errorText } from "./api.ts";
import { log } from "./devlog.ts";

/** Spread on an element to make it, and its empty parts, move the window (double-click zooms it). */
export const WINDOW_DRAG = { "data-window-drag": "" };
/** The same, for a bar whose double-click already means something else. */
export const WINDOW_MOVE_ONLY = { "data-window-drag": "move" };

/** Pressing these never moves the window. */
const CONTROLS = "button, a, input, textarea, select, label, [role=button], [contenteditable]:not([contenteditable=false])";

/** Whether a press on `target` should move the window. */
export function movesWindow(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest("[data-window-drag]") && !target.closest(CONTROLS);
}

export function setUpWindowChrome() {
  if (!("__TAURI_INTERNALS__" in window)) return; // a plain browser (tests, vite without the app)
  const window_ = getCurrentWindow();

  document.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || !movesWindow(event.target)) return;
    const moveOnly = (event.target as Element).closest("[data-window-drag]")?.getAttribute("data-window-drag") === "move";
    if (moveOnly && event.detail === 2) return; // the bar's own double-click
    event.preventDefault(); // no text selection, no focus change
    const action = event.detail === 2 ? window_.toggleMaximize() : event.detail === 1 ? window_.startDragging() : null;
    action?.catch((e) => log("warn", "ui", `Couldn't ${event.detail === 2 ? "zoom" : "move"} the window: ${errorText(e)}`));
  });

  if (!/Mac/i.test(navigator.userAgent)) return;
  const root = document.documentElement;
  root.classList.add("overlay-titlebar");
  const update = () =>
    window_
      .isFullscreen()
      .then((fullscreen) => root.classList.toggle("fullscreen", fullscreen))
      .catch(() => {});
  void update();
  void window_.onResized(() => void update());
}
