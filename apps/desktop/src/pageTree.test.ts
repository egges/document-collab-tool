import { expect, test } from "vitest";
import { ancestry, displayOrder, search, trail } from "./pageTree.ts";

const pages = [
  { id: "a", title: "Alpha", parent: null, kind: "page" as const, database: null },
  { id: "b", title: "Beta plan", parent: null, kind: "page" as const, database: null },
  { id: "a1", title: "Plans", parent: "a", kind: "page" as const, database: null },
  { id: "a1x", title: "Launch", parent: "a1", kind: "page" as const, database: null },
];

test("display order is depth first, like the sidebar", () => {
  expect(displayOrder(pages).map((p) => p.id)).toEqual(["a", "a1", "a1x", "b"]);
});

test("ancestry lists parents outermost first", () => {
  expect(ancestry(pages, "a1x")).toEqual(["Alpha", "Plans"]);
  expect(ancestry(pages, "a")).toEqual([]);
});

test("search ranks title starts, then word starts, then anywhere", () => {
  expect(search(pages, "pla").map((p) => p.id)).toEqual(["a1", "b"]);
  expect(search(pages, "unc").map((p) => p.id)).toEqual(["a1x"]);
  expect(search(pages, "").length).toBe(4);
});

test("the trail is the page with its ancestors, outermost first", () => {
  expect(trail(pages, "a1x").map((p) => p.id)).toEqual(["a", "a1", "a1x"]);
  expect(trail(pages, "b").map((p) => p.id)).toEqual(["b"]);
  expect(trail(pages, "missing")).toEqual([]);
});
