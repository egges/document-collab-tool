import { expect, test } from "vitest";
import { parseAccent } from "./preferences.ts";

test("violet is the default accent, and a saved one comes back", () => {
  expect(parseAccent(null)).toBe("violet");
  expect(parseAccent("teal")).toBe("violet");
  expect(parseAccent("green")).toBe("green");
});
