import { expect, test } from "vitest";
import { DEFAULT_PAGE_FONT, PAGE_FONTS, parsePageFont } from "./pageFont.ts";

test("sans-serif is the default, and serif is one of the choices", () => {
  expect(DEFAULT_PAGE_FONT).toBe("sans");
  expect(PAGE_FONTS.map((f) => f.id)).toContain("serif");
});

test("a saved choice comes back; anything else is the default", () => {
  expect(parsePageFont("serif")).toBe("serif");
  expect(parsePageFont("mono")).toBe("mono");
  expect(parsePageFont(null)).toBe("sans");
  expect(parsePageFont("comic-sans")).toBe("sans");
});
