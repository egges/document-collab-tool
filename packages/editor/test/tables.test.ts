import { describe, expect, test } from "vitest";
import { TextSelection } from "@milkdown/kit/prose/state";
import { type PageEditor, createPageEditor } from "../src/index.ts";
import { type TableEdit, canEditTable, tableCellAt } from "../src/tables.ts";

const TABLE = `Before.

| Name | Role  |
| :--- | ----: |
| Ada  | Lead  |
| Alan | Staff |

After.
`;

const open = (markdown = TABLE) => createPageEditor({ root: document.createElement("div"), markdown });

/** Puts the cursor in the cell whose text is `text`. */
function cursorIn(editor: PageEditor, text: string) {
  const { view } = editor;
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text === text) at = pos;
    return at < 0;
  });
  if (at < 0) throw new Error(`"${text}" not in document`);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
}

/** Makes `edit` at the cell with `text`, then types `typed` where the cursor ends up. */
async function edit(text: string, change: TableEdit, typed?: string) {
  const editor = await open();
  cursorIn(editor, text);
  const ok = editor.commands.editTable(editor.commands.tableCellAt()!, change);
  if (ok && typed) editor.view.dispatch(editor.view.state.tr.insertText(typed));
  const saved = editor.save();
  await editor.destroy();
  return { ok, saved };
}

describe("finding the cell", () => {
  test("knows the row, column and size", async () => {
    const editor = await open();
    cursorIn(editor, "Staff");
    expect(editor.commands.tableCellAt()).toMatchObject({ row: 2, col: 1, rows: 3, cols: 2 });
    cursorIn(editor, "Name");
    expect(editor.commands.tableCellAt()).toMatchObject({ row: 0, col: 0 });
    cursorIn(editor, "After.");
    expect(editor.commands.tableCellAt()).toBeNull();
    await editor.destroy();
  });
});

describe("rows", () => {
  test("a row below, aligned like the header, with the cursor in it", async () => {
    const { saved } = await edit("Ada", "rowBelow", "Grace");
    expect(saved).toContain("| Ada | Lead |\n| Grace | |\n| Alan | Staff |");
    // Alignment comes from the header row, so the delimiter row is unchanged.
    expect(saved).toContain("| :- | -: |");
  });

  test("a row above a body row", async () => {
    const { saved } = await edit("Alan", "rowAbove", "Grace");
    expect(saved).toContain("| Ada | Lead |\n| Grace | |\n| Alan | Staff |");
  });

  test("a row below the header goes first under it", async () => {
    const { saved } = await edit("Role", "rowBelow");
    expect(saved).toContain("| :- | -: |\n| | |\n| Ada | Lead |");
  });

  test("nothing goes above the header", async () => {
    expect(await edit("Name", "rowAbove")).toEqual({ ok: false, saved: null });
  });

  test("deleting a row keeps the cursor in that column", async () => {
    const editor = await open();
    cursorIn(editor, "Lead");
    expect(editor.commands.editTable(editor.commands.tableCellAt()!, "deleteRow")).toBe(true);
    expect(editor.save()).toContain("| :- | -: |\n| Alan | Staff |\n\nAfter.");
    expect(editor.commands.tableCellAt()).toMatchObject({ row: 1, col: 1 });
    await editor.destroy();
  });

  test("the header and the last row under it stay", async () => {
    expect((await edit("Name", "deleteRow")).ok).toBe(false);
    const editor = await open("| A |\n| - |\n| b |\n");
    cursorIn(editor, "b");
    const cell = editor.commands.tableCellAt()!;
    expect(canEditTable(cell, "deleteRow")).toBe(false);
    expect(editor.commands.editTable(cell, "deleteRow")).toBe(false);
    await editor.destroy();
  });
});

describe("columns", () => {
  test("a column to the right, with the cursor in it", async () => {
    const { saved } = await edit("Name", "columnRight", "Team");
    expect(saved).toContain("| Name | Team | Role |");
    expect(saved).toContain("| Ada | | Lead |");
  });

  test("a column to the left", async () => {
    const { saved } = await edit("Lead", "columnLeft", "x");
    expect(saved).toContain("| Name | | Role |");
    expect(saved).toContain("| Ada | x | Lead |");
  });

  test("deleting a column keeps the others' alignment", async () => {
    const { saved } = await edit("Ada", "deleteColumn");
    expect(saved).toContain("| Role |\n| -: |\n| Lead |\n| Staff |");
  });

  test("deleting the only column deletes the table", async () => {
    const editor = await open("Before.\n\n| A |\n| - |\n| b |\n\nAfter.\n");
    cursorIn(editor, "b");
    expect(editor.commands.editTable(editor.commands.tableCellAt()!, "deleteColumn")).toBe(true);
    expect(editor.save()).toBe("Before.\n\nAfter.\n");
    await editor.destroy();
  });
});

test("each edit is one undo step", async () => {
  const editor = await open();
  cursorIn(editor, "Ada");
  editor.commands.editTable(editor.commands.tableCellAt()!, "columnRight");
  editor.commands.editTable(editor.commands.tableCellAt()!, "rowBelow");
  const { undo } = await import("@milkdown/kit/prose/history");
  undo(editor.view.state, editor.view.dispatch);
  expect(editor.save()).toContain("| Name | | Role |");
  undo(editor.view.state, editor.view.dispatch);
  expect(editor.save()).toBeNull();
  await editor.destroy();
});

test("a stale cell (the table changed meanwhile) does nothing", async () => {
  const editor = await open();
  cursorIn(editor, "Staff");
  const cell = editor.commands.tableCellAt()!;
  cursorIn(editor, "Lead");
  editor.commands.editTable(editor.commands.tableCellAt()!, "deleteRow");
  expect(editor.commands.editTable(cell, "deleteRow")).toBe(false);
  await editor.destroy();
});

test("a new column has no alignment, like one written by hand", async () => {
  const editor = await open("| A |\n| - |\n| b |\n");
  cursorIn(editor, "b");
  editor.commands.editTable(editor.commands.tableCellAt()!, "columnRight");
  expect(editor.save()).toBe("| A | |\n| - | - |\n| b | |\n");
  await editor.destroy();
});

describe("moving rows and columns", () => {
  const ROWS = "| H |\n| - |\n| a |\n| b |\n| c |\n";
  async function move(markdown: string, text: string, line: "row" | "column", to: number) {
    const editor = await open(markdown);
    cursorIn(editor, text);
    const ok = editor.commands.moveTableLine(editor.commands.tableCellAt()!, line, to);
    const cell = editor.commands.tableCellAt();
    const saved = editor.save();
    await editor.destroy();
    return { ok, saved, cell };
  }

  test("a row moves down and up, with the cursor in it", async () => {
    const down = await move(ROWS, "a", "row", 3);
    expect(down.saved).toBe("| H |\n| - |\n| b |\n| c |\n| a |\n");
    expect(down.cell).toMatchObject({ row: 3, col: 0 });
    expect((await move(ROWS, "c", "row", 1)).saved).toBe("| H |\n| - |\n| c |\n| a |\n| b |\n");
  });

  test("the header row stays first", async () => {
    expect(await move(ROWS, "H", "row", 2)).toMatchObject({ ok: false, saved: null });
    expect(await move(ROWS, "b", "row", 0)).toMatchObject({ ok: false, saved: null });
  });

  test("a column moves with its header and alignment", async () => {
    const { saved, cell } = await move(TABLE, "Ada", "column", 1);
    expect(saved).toContain("| Role | Name |\n| -: | :- |\n| Lead | Ada |");
    expect(cell).toMatchObject({ row: 2 - 1, col: 1 });
  });

  test("moving to where it is does nothing", async () => {
    expect(await move(ROWS, "b", "row", 2)).toMatchObject({ ok: false, saved: null });
  });
});
