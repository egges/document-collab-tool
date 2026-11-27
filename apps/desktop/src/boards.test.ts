import { expect, test } from "vitest";
import type { Column, Database, Row, View } from "./api.ts";
import {
  boardColumn,
  cardFields,
  dropPositions,
  lanes,
  newViewName,
  nextViewPosition,
  titleColumn,
  viewOrder,
} from "./boards.ts";

const col = (id: string, extra: Partial<Column> = {}): Column => ({
  id,
  name: id,
  type: "text",
  position: null,
  options: [],
  ...extra,
});
const row = (id: string, cells: Record<string, unknown> = {}, extra: Partial<Row> = {}): Row => ({
  id,
  cells,
  position: null,
  positions: {},
  ...extra,
});
const view = (extra: Partial<View> = {}): View => ({
  id: "v",
  name: "Board",
  type: "board",
  position: 0,
  sort: null,
  groupBy: null,
  ...extra,
});

const status = col("status", { type: "select", options: ["Todo", "Doing", "Done"] });

test("a board groups by the view's column, else the first select or checkbox column", () => {
  const db: Database = {
    id: "db",
    name: "Tasks",
    path: "",
    rows: [],
    columns: [col("name"), col("done", { type: "checkbox" }), status],
  };
  expect(boardColumn(db, view())?.id).toBe("done");
  expect(boardColumn(db, view({ groupBy: "status" }))?.id).toBe("status");
  expect(boardColumn(db, view({ groupBy: "name" }))?.id).toBe("done");
  expect(boardColumn({ ...db, columns: [col("name")] }, view())).toBeNull();
});

test("select lanes follow the choices, with stray values and empty cards kept", () => {
  const rows = [
    row("a", { status: "Done" }),
    row("b"),
    row("c", { status: "Blocked" }),
    row("d", { status: "Todo" }),
    row("e", { status: 3 }),
  ];
  const result = lanes(rows, status);
  expect(result.map((l) => l.label)).toEqual(["No status", "Todo", "Doing", "Done", "Blocked"]);
  expect(result.map((l) => l.rows.map((r) => r.id))).toEqual([["b", "e"], ["d"], [], ["a"], ["c"]]);
  expect(result[0].value).toBeNull();
  expect(result[1].value).toBe("Todo");
  // Without empty cards there's no empty lane.
  expect(lanes([row("a", { status: "Done" })], status)[0].label).toBe("Todo");
});

test("checkbox lanes are not checked, then checked", () => {
  const done = col("done", { type: "checkbox" });
  const result = lanes([row("a", { done: true }), row("b"), row("c", { done: false })], done);
  expect(result.map((l) => [l.label, l.value, l.rows.map((r) => r.id)])).toEqual([
    ["Not checked", null, ["b", "c"]],
    ["Checked", true, ["a"]],
  ]);
});

/** A row added at `position`, and where it was dropped in view "v", if it was. */
const at = (id: string, position: number | null, dropped?: number): Row =>
  row(id, {}, { position, positions: dropped === undefined ? {} : { v: dropped, other: -1 } });
const ids = (rows: Row[]) => rows.map((r) => r.id);

test("cards are in the view's own order: where they were dropped, else where their row is", () => {
  const rows = [at("a", 10), at("b", 20, 5), at("c", 30), at("d", 40, 25), at("e", null), at("f", null)];
  expect(ids(viewOrder(rows, "v"))).toEqual(["b", "a", "d", "c", "e", "f"]);
  // Another view has its own order, and one nobody dragged in has the database's.
  expect(ids(viewOrder(rows, "other"))).toEqual(["b", "d", "a", "c", "e", "f"]);
  expect(ids(viewOrder(rows, "new"))).toEqual(ids(rows));
});

test("a dropped card gets one position, between its new neighbours", () => {
  const cards = [at("a", 10), at("b", 20, 12), at("c", 30)];
  const moved = at("m", 100);
  expect(dropPositions(cards, 0, moved, "v")).toEqual({ m: 9 });
  expect(dropPositions(cards, 1, moved, "v")).toEqual({ m: 11 });
  expect(dropPositions(cards, 2, moved, "v")).toEqual({ m: 21 });
  // Every drop lands where it was aimed.
  for (let index = 0; index <= cards.length; index++) {
    const { m } = dropPositions(cards, index, moved, "v");
    const placed = m === undefined ? moved : { ...moved, positions: { v: m } };
    const expected = [...cards.slice(0, index), moved, ...cards.slice(index)];
    expect(ids(viewOrder([placed, ...cards], "v"))).toEqual(ids(expected));
  }
});

test("a card that already sorts where it's dropped keeps its position", () => {
  const cards = [at("a", 10), at("c", 30)];
  // Into another lane, at the place its row has anyway: nothing to write.
  expect(dropPositions(cards, 2, at("m", 100), "v")).toEqual({});
  expect(dropPositions(cards, 1, at("m", 20), "v")).toEqual({});
  expect(dropPositions([], 0, at("m", null), "v")).toEqual({});
  // A position from an earlier drop counts, not the row's.
  expect(dropPositions(cards, 1, at("m", 20, 5), "v")).toEqual({ m: 20 });
});

test("cards that leave no room between them are numbered again", () => {
  // Two cards at one position.
  expect(dropPositions([at("a", 10), at("b", 10)], 1, at("m", 50), "v")).toEqual({ a: 10, m: 11, b: 12 });
  // Cards without a position sort last, by id: nothing fits after or between them.
  expect(dropPositions([at("a", 10), at("b", null)], 2, at("m", 5), "v")).toEqual({ a: 10, b: 11, m: 12 });
  expect(dropPositions([at("a", null), at("b", null)], 1, at("m", 5), "v")).toEqual({ a: 0, m: 1, b: 2 });
  // No number left between two neighbours.
  const tight = [at("a", 1), at("b", 1 + Number.EPSILON)];
  expect(dropPositions(tight, 1, at("m", 50), "v")).toEqual({ a: 1, m: 2, b: 3 });
});

test("cards show their title and the other fields that have a value", () => {
  const columns = [col("n", { type: "number" }), col("notes"), col("name", { type: "title" }), status, col("done", { type: "checkbox" })];
  expect(titleColumn(columns)?.id).toBe("name");
  expect(titleColumn([col("n", { type: "number" })])).toBeNull();
  const fields = cardFields(row("r", { n: 0, name: "Write", status: "Todo", done: false }), columns, ["name", "status"]);
  expect(fields.map((f) => f.column.id)).toEqual(["n"]);
});

test("new views get a free name and go last", () => {
  const views = [view({ name: "Board", position: 0 }), view({ name: "Board 2", position: 3.5 })];
  expect(newViewName(views, "Board")).toBe("Board 3");
  expect(newViewName(views, "Table")).toBe("Table");
  expect(nextViewPosition(views)).toBe(4);
  expect(nextViewPosition([])).toBe(0);
});
