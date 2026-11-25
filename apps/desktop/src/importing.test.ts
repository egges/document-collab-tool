import { describe, expect, test } from "vitest";
import { importNotice } from "./importing.ts";

const result = (pageCount: number, skipped: string[] = []) => ({ pages: [], pageCount, assetCount: 0, skipped });

describe("importNotice", () => {
  test("says nothing when everything was imported", () => {
    expect(importNotice(result(3))).toBeNull();
  });

  test("explains an import that found nothing", () => {
    expect(importNotice(result(0))).toBe("There were no Markdown files to import.");
    expect(importNotice(result(0, ["a.txt"]))).toBe("Nothing was imported: “a.txt” isn't Markdown.");
  });

  test("lists what was left out", () => {
    expect(importNotice(result(1, ["a.txt", "b.pdf"]))).toBe("Imported 1 page. Left out: “a.txt” and “b.pdf”.");
    expect(importNotice(result(5, ["a", "b", "c", "d"]))).toBe("Imported 5 pages. Left out: “a”, “b” and 2 more.");
  });
});
