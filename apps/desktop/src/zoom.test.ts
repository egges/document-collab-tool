import { expect, test } from "vitest";
import { nextZoom, zoomKey } from "./zoom.ts";

const press = (init: Partial<KeyboardEvent>) =>
  ({ key: "", code: "", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent;

test("⌘+ / ⌘− / ⌘0, on any layout, with or without Shift", () => {
  expect(zoomKey(press({ key: "=", code: "Equal", metaKey: true }), true)).toBe("in");
  expect(zoomKey(press({ key: "+", code: "Equal", metaKey: true, shiftKey: true }), true)).toBe("in");
  expect(zoomKey(press({ key: "+", code: "BracketRight", metaKey: true }), true)).toBe("in"); // German layout
  expect(zoomKey(press({ key: "+", code: "NumpadAdd", metaKey: true }), true)).toBe("in");
  expect(zoomKey(press({ key: "-", code: "Minus", metaKey: true }), true)).toBe("out");
  expect(zoomKey(press({ key: "0", code: "Digit0", metaKey: true }), true)).toBe("reset");
  expect(zoomKey(press({ key: "=", code: "Equal", ctrlKey: true }), false)).toBe("in");
});

test("not without ⌘, nor with ⌥ or the other modifier", () => {
  expect(zoomKey(press({ key: "=", code: "Equal" }), true)).toBeNull();
  expect(zoomKey(press({ key: "=", code: "Equal", ctrlKey: true }), true)).toBeNull();
  expect(zoomKey(press({ key: "-", code: "Minus", metaKey: true, altKey: true }), true)).toBeNull();
  expect(zoomKey(press({ key: "k", code: "KeyK", metaKey: true }), true)).toBeNull();
});

test("steps like a browser and stops at the ends", () => {
  expect(nextZoom(1, "in")).toBe(1.1);
  expect(nextZoom(1, "out")).toBe(0.9);
  expect(nextZoom(1.1, "out")).toBe(1);
  expect(nextZoom(2, "in")).toBe(2);
  expect(nextZoom(0.5, "out")).toBe(0.5);
  expect(nextZoom(1.75, "reset")).toBe(1);
});
