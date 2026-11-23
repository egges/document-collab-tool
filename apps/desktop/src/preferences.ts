// Smaller per-device settings, shown in Settings. The theme and the page
// font have their own files (theme.ts, pageFont.ts).
import { devicePref } from "./devicePref.ts";

export const ACCENTS = [
  { id: "violet", label: "Violet" },
  { id: "blue", label: "Blue" },
  { id: "green", label: "Green" },
  { id: "orange", label: "Orange" },
  { id: "pink", label: "Pink" },
] as const;

export type Accent = (typeof ACCENTS)[number]["id"];

export function parseAccent(saved: string | null): Accent {
  return ACCENTS.some((a) => a.id === saved) ? (saved as Accent) : "violet";
}

/** The colour of buttons, selections and links. app.css has each one's shades. */
export const accent = devicePref("accent", parseAccent, (value) => {
  document.documentElement.dataset.accent = value;
});

const onOff = (fallback: "on" | "off") => (saved: string | null) =>
  saved === "on" || saved === "off" ? saved : fallback;

/**
 * Underline misspelled words in pages. The checking is the system's own
 * (its dictionaries and languages); this only turns it on or off. Inputs that
 * say otherwise (code, names, URLs) keep their own setting.
 */
export const spellcheck = devicePref("spellcheck", onOff("on"), (value) => {
  document.documentElement.spellcheck = value === "on";
});

/** Offer the developer log (⌘J) in any build, not only debug ones. */
export const devLog = devicePref("devLog", onOff("off"), () => {});

/** Applies them all; call once at startup. */
export function setUpPreferences() {
  accent.load();
  spellcheck.load();
}
