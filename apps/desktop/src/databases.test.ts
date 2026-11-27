import { expect, test } from "vitest";
import type { Column, Row } from "./api.ts";
import { cellText, fits, movedPosition, newColumnName, optionTone, parseCell, sortRows } from "./databases.ts";

const row = (id: string, cells: Row["cells"] = {}): Row => ({ id, cells, position: null, positions: {} });
const col = (id: string, position: number | null, extra: Partial<Column> = {}): Column => ({
  id,
  name: id,
  type: "text",
  position,
  options: [],
  ...extra,
});

test("typing into a cell stores a value of the column's type, or says why not", () => {
  expect(parseCell("number", " 1,250.5 ")).toEqual({ value: 1250.5 });
  expect(parseCell("number", "abc")).toEqual({ error: "“abc” isn't a number." });
  expect(parseCell("date", "2026-11-25")).toEqual({ value: "2026-11-25" });
  expect(parseCell("date", "tomorrow")).toHaveProperty("error");
  expect(parseCell("text", "  keeps spaces ")).toEqual({ value: "  keeps spaces " });
  expect(parseCell("url", " https://x.dev ")).toEqual({ value: "https://x.dev" });
  expect(parseCell("text", "   ")).toEqual({ value: null });
  expect(parseCell("checkbox", "Yes")).toEqual({ value: true });
});

test("values of another type show as they are", () => {
  expect(fits("number", "3")).toBe(false);
  expect(fits("checkbox", false)).toBe(true);
  expect(cellText(3)).toBe("3");
  expect(cellText(undefined)).toBe("");
  expect(cellText({ a: 1 })).toBe('{"a":1}');
});

test("sorting puts empty cells last both ways, numbers by value and choices in their order", () => {
  const rows: Row[] = [row("a", { n: 10, s: "Done" }), row("b"), row("c", { n: 9, s: "Todo" })];
  const n = col("n", 0, { type: "number" });
  expect(sortRows(rows, n, "asc").map((r) => r.id)).toEqual(["c", "a", "b"]);
  expect(sortRows(rows, n, "desc").map((r) => r.id)).toEqual(["a", "c", "b"]);
  const s = col("s", 1, { type: "select", options: ["Todo", "Done"] });
  expect(sortRows(rows, s, "asc").map((r) => r.id)).toEqual(["c", "a", "b"]);
  const text: Row[] = [row("x", { t: "item 10" }), row("y", { t: "Item 9" })];
  expect(sortRows(text, col("t", 0), "asc").map((r) => r.id)).toEqual(["y", "x"]);
});

test("moving a column changes only its position, to between its new neighbours", () => {
  const columns = [col("a", 0), col("b", 1), col("c", 2)];
  expect(movedPosition(columns, 2, 0)).toBe(-1); // c to the front
  expect(movedPosition(columns, 0, 1)).toBe(1.5); // a between b and c
  expect(movedPosition(columns, 0, 2)).toBe(3); // a to the end
  expect(movedPosition(columns, 1, 0)).toBe(-1);
  // Columns without a position count as one after the one before.
  expect(movedPosition([col("a", 0), col("b", null), col("c", null)], 0, 2)).toBe(3);
});

test("new columns get a free name, and choices a stable colour", () => {
  expect(newColumnName([col("Name", 0)])).toBe("Column 2");
  expect(newColumnName([{ ...col("x", 0), name: "Column 2" }, col("y", 1)])).toBe("Column 3");
  const options = ["Idea", "Drafting", "Done"];
  expect(options.map((o) => optionTone(o, options))).toEqual([1, 2, 3]);
  expect(optionTone("Other", options)).toBe(optionTone("Other", []));
  expect(optionTone("Other", options)).toBeGreaterThanOrEqual(1);
  expect(optionTone("Other", options)).toBeLessThanOrEqual(6);
});
