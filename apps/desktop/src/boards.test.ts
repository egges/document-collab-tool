import { expect, test } from "vitest";
import type { Column, Database, Row, View } from "./api.ts";
import { boardColumn, cardFields, lanes, newViewName, nextViewPosition, titleColumn } from "./boards.ts";

const col = (id: string, extra: Partial<Column> = {}): Column => ({
  id,
  name: id,
  type: "text",
  position: null,
  options: [],
  ...extra,
});
const row = (id: string, cells: Record<string, unknown> = {}): Row => ({ id, cells });
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

test("cards show their title and the other fields that have a value", () => {
  const columns = [col("n", { type: "number" }), col("name"), status, col("done", { type: "checkbox" })];
  expect(titleColumn(columns)?.id).toBe("name");
  expect(titleColumn([col("n", { type: "number" })])?.id).toBe("n");
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
