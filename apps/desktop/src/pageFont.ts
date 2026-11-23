// The typeface pages are written and read in: sans-serif (the default),
// serif, rounded or mono. Kept per device, like the zoom level: it's how this
// person likes to read, not something to sync. The app's own menus and
// buttons always use the sans-serif face.
//
// The fonts ship with the app (see main.tsx), so they look the same on every
// computer and need no connection. app.css maps each choice to its fonts
// with `:root[data-page-font=…]`.
import { devicePref } from "./devicePref.ts";

export const PAGE_FONTS = [
  { id: "sans", label: "Sans", hint: "Clean and modern" },
  { id: "serif", label: "Serif", hint: "Like a good book" },
  { id: "rounded", label: "Rounded", hint: "Soft and friendly" },
  { id: "mono", label: "Mono", hint: "For a typewriter feel" },
] as const;

export type PageFont = (typeof PAGE_FONTS)[number]["id"];

export const DEFAULT_PAGE_FONT: PageFont = "sans";

/** The choice `saved` stands for; anything unknown is the default. */
export function parsePageFont(saved: string | null | undefined): PageFont {
  return PAGE_FONTS.some((f) => f.id === saved) ? (saved as PageFont) : DEFAULT_PAGE_FONT;
}

export const pageFont = devicePref("pageFont", parsePageFont, (font) => {
  document.documentElement.dataset.pageFont = font;
});
