import { expect, test } from "vitest";
import { ancestry, displayOrder, search } from "./pageTree.ts";

const pages = [
  { id: "a", title: "Alpha", parent: null },
  { id: "b", title: "Beta plan", parent: null },
  { id: "a1", title: "Plans", parent: "a" },
  { id: "a1x", title: "Launch", parent: "a1" },
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
