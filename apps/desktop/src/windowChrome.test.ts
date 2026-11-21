// @vitest-environment jsdom
import { expect, test } from "vitest";
import { movesWindow } from "./windowChrome.ts";

test("empty parts of the title bar move the window; its controls don't", () => {
  document.body.innerHTML = `
    <div class="titlebar" data-window-drag>
      <nav><span class="sep">›</span><button><span class="label">Page</span></button></nav>
      <div class="spacer"></div>
      <input />
    </div>
    <main><p class="text">Not the title bar</p></main>`;
  const $ = (selector: string) => document.querySelector(selector);
  expect(movesWindow($(".titlebar"))).toBe(true);
  expect(movesWindow($(".spacer"))).toBe(true);
  expect(movesWindow($("nav"))).toBe(true);
  expect(movesWindow($(".sep"))).toBe(true);
  expect(movesWindow($("button"))).toBe(false);
  expect(movesWindow($(".label"))).toBe(false); // inside a button
  expect(movesWindow($("input"))).toBe(false);
  expect(movesWindow($(".text"))).toBe(false);
  expect(movesWindow(null)).toBe(false);
});
