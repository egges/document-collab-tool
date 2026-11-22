import { expect, test } from "vitest";
import { menuStep } from "./menu.ts";

test("arrow keys move through a menu and wrap around", () => {
  expect(menuStep(-1, 1, 3)).toBe(0);
  expect(menuStep(-1, -1, 3)).toBe(2);
  expect(menuStep(0, 1, 3)).toBe(1);
  expect(menuStep(2, 1, 3)).toBe(0);
  expect(menuStep(0, -1, 3)).toBe(2);
  expect(menuStep(-1, 1, 0)).toBe(-1);
});
