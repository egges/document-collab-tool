import { expect, test } from "vitest";
import { parseTheme, resolveTheme } from "./theme.ts";

test("follows the system unless light or dark was chosen", () => {
  expect(parseTheme(null)).toBe("system");
  expect(parseTheme("sepia")).toBe("system");
  expect(parseTheme("dark")).toBe("dark");
});

test("a chosen theme wins over the system's", () => {
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme("light", true)).toBe("light");
  expect(resolveTheme("dark", false)).toBe("dark");
});
