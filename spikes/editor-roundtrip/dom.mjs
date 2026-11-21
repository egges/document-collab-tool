// The editors expect a browser DOM. Provide one from jsdom before any editor
// module is imported.
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
const define = (key, value) =>
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });

define("window", window);
for (const key of ["document", "navigator", "Node", "Element", "HTMLElement",
  "DocumentFragment", "MutationObserver", "getComputedStyle", "DOMParser", "Text"]) {
  if (!(key in globalThis)) {
    const value = window[key];
    define(key, typeof value === "function" && /^[a-z]/.test(key) ? value.bind(window) : value);
  }
}

// Global events (Milkdown uses them for its startup timers). Node's own Event
// and CustomEvent are kept, so use a Node EventTarget to match them.
const events = new EventTarget();
for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"]) {
  define(key, events[key].bind(events));
}
define("requestAnimationFrame", (fn) => setTimeout(() => fn(Date.now()), 0));
define("cancelAnimationFrame", (id) => clearTimeout(id));
