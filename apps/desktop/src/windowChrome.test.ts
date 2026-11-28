// @vitest-environment jsdom
import { expect, test } from "vitest";
import { movesWindow, refuseFileDrops } from "./windowChrome.ts";

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

test("files dropped outside a place that takes them are refused, not opened", () => {
  refuseFileDrops(window);
  document.body.innerHTML = `<div class="page"></div><div class="sidebar"></div>`;
  document.querySelector(".page")!.addEventListener("dragover", (e) => e.preventDefault());
  const drag = (type: string, selector: string, types = ["Files"]) => {
    const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", { value: { types, dropEffect: "copy" } });
    document.querySelector(selector)!.dispatchEvent(event);
    return event;
  };
  const outside = drag("dragover", ".sidebar");
  expect(outside.defaultPrevented).toBe(true);
  expect(outside.dataTransfer!.dropEffect).toBe("none");
  expect(drag("dragover", ".page").dataTransfer!.dropEffect).toBe("copy");
  expect(drag("drop", ".sidebar").defaultPrevented).toBe(true);
  expect(drag("dragover", ".sidebar", ["text/plain"]).defaultPrevented).toBe(false);
});
