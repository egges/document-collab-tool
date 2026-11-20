// Tiptap and ProseMirror expect a browser DOM. Provide one from jsdom before
// any editor module is imported.
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement",
  "DocumentFragment", "MutationObserver", "getComputedStyle", "DOMParser", "Text"]) {
  if (!(key in globalThis)) {
    Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true });
  }
}
