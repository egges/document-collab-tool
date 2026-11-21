// On macOS the window has no title bar of its own (tauri.macos.conf.json):
// the app draws one, and the close, minimise and zoom buttons sit over its
// top left corner. This tells the styles to leave room for them, except in
// full screen, where macOS hides them. Elsewhere the system title bar stays.
import { getCurrentWindow } from "@tauri-apps/api/window";

export function setUpWindowChrome() {
  const inApp = "__TAURI_INTERNALS__" in window;
  if (!inApp || !/Mac/i.test(navigator.userAgent)) return;
  const root = document.documentElement;
  root.classList.add("overlay-titlebar");
  const window_ = getCurrentWindow();
  const update = () =>
    window_
      .isFullscreen()
      .then((fullscreen) => root.classList.toggle("fullscreen", fullscreen))
      .catch(() => {});
  void update();
  void window_.onResized(() => void update());
}
