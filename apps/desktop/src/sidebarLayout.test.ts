import { expect, test } from "vitest";
import { SIDEBAR_WIDTH, clampWidth } from "./sidebarLayout.ts";

test("the sidebar width stays within limits", () => {
  expect(clampWidth(10)).toBe(SIDEBAR_WIDTH.min);
  expect(clampWidth(5000)).toBe(SIDEBAR_WIDTH.max);
  expect(clampWidth(300.4)).toBe(300);
  expect(clampWidth(Number.NaN)).toBe(SIDEBAR_WIDTH.default);
});
