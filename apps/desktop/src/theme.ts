// Light or dark: follow the system (the default), or always one of them.
// Kept per device, like the zoom level.
//
// The page always says which one it shows, as `data-theme="light"` or
// `"dark"` on <html>, and the styles only look at that, never at the
// system's setting themselves. The window's own parts (its buttons, native
// dialogs) are told too.
import { devicePref } from "./devicePref.ts";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { errorText } from "./api.ts";
import { log } from "./devlog.ts";

export const THEMES = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;

export type Theme = (typeof THEMES)[number]["id"];

/** The choice `saved` stands for; anything unknown follows the system. */
export function parseTheme(saved: string | null | undefined): Theme {
  return THEMES.some((t) => t.id === saved) ? (saved as Theme) : "system";
}

/** What `theme` looks like when the system is dark or not. */
export function resolveTheme(theme: Theme, systemDark: boolean): "light" | "dark" {
  return theme === "system" ? (systemDark ? "dark" : "light") : theme;
}

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

export const theme = devicePref("theme", parseTheme, (choice) => {
  document.documentElement.dataset.theme = resolveTheme(choice, systemDark());
  if (!("__TAURI_INTERNALS__" in window)) return;
  getCurrentWindow()
    .setTheme(choice === "system" ? null : choice)
    .catch((e) => log("warn", "ui", `Couldn't set the window's theme: ${errorText(e)}`));
});

/** Applies the saved choice, and follows the system while it's "system". Call once, before the first paint. */
export function setUpTheme() {
  theme.load();
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", (e) => {
      if (theme.get() === "system") document.documentElement.dataset.theme = e.matches ? "dark" : "light";
    });
}
