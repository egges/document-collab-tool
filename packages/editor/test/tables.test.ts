import { describe, expect, test } from "vitest";
import { undo } from "@milkdown/kit/prose/history";
import { TextSelection } from "@milkdown/kit/prose/state";
import { type PageEditor, createPageEditor, formatPage } from "../src/index.ts";
import {
  DEFAULT_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  type TableEdit,
  type TableLayout,
  canEditTable,
  tableCellAt,
  tableWidths,
} from "../src/tables.ts";

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

describe("column widths", () => {
  const FIXED = "<!-- table-widths: 120px 200px -->\n\n| A | B |\n| - | - |\n| 1 | 2 |\n";
  const FULL = "<!-- table-widths: 40% 60% -->\n\n| A | B |\n| - | - |\n| 1 | 2 |\n";
  const PLAIN = "| A | B |\n| - | - |\n| 1 | 2 |\n";

  /** Sizes the first table, then returns what's saved and how it's drawn. */
  async function size(markdown: string, layout: TableLayout, widths?: number[]) {
    const editor = await open(markdown);
    cursorIn(editor, "1");
    const ok = editor.commands.setTableWidths(editor.commands.tableCellAt()!, layout, widths);
    const saved = editor.save();
    const table = editor.view.dom.querySelector("table")!;
    await editor.destroy();
    return { ok, saved, table };
  }

  test("are read from the comment above the table, which isn't shown", async () => {
    const editor = await open(`Intro.\n\n${FIXED}`);
    expect(editor.view.dom.textContent).toBe("Intro.AB12");
    expect(tableWidths(editor.view.state.doc.child(1))).toEqual({ layout: "fixed", widths: [120, 200] });
    const table = editor.view.dom.querySelector("table")!;
    expect(table.style.width).toBe("320px");
    expect([...table.querySelectorAll("col")].map((c) => c.style.width)).toEqual(["120px", "200px"]);
    // Unchanged, so nothing to save; once edited, the comment is written back.
    expect(editor.save()).toBeNull();
    cursorIn(editor, "Intro.");
    editor.view.dispatch(editor.view.state.tr.insertText("!"));
    expect(editor.save()).toBe(`!Intro.\n\n${FIXED}`);
    await editor.destroy();
  });

  test("full width is in percentages of the page", async () => {
    const editor = await open(FULL);
    expect(tableWidths(editor.view.state.doc.firstChild!)).toEqual({ layout: "full", widths: [40, 60] });
    const table = editor.view.dom.querySelector("table")!;
    expect(table.style.width).toBe("100%");
    expect([...table.querySelectorAll("col")].map((c) => c.style.width)).toEqual(["40%", "60%"]);
    await editor.destroy();
  });

  test("full width without widths shares the page by content", async () => {
    const markdown = `<!-- table-widths: full -->\n\n${PLAIN}`;
    const editor = await open(markdown);
    expect(tableWidths(editor.view.state.doc.firstChild!)).toEqual({ layout: "full", widths: [null, null] });
    const table = editor.view.dom.querySelector("table")!;
    expect(table.style.width).toBe("100%");
    expect(table.style.tableLayout).toBe("");
    expect(table.querySelector("colgroup")).toBeNull();
    // A new column stays without a width.
    cursorIn(editor, "2");
    editor.commands.editTable(editor.commands.tableCellAt()!, "columnRight");
    expect(editor.save()).toBe("<!-- table-widths: full -->\n\n| A | B | |\n| - | - | - |\n| 1 | 2 | |\n");
    await editor.destroy();
    expect((await size(PLAIN, "full")).saved).toBe(markdown);
    expect((await size(FULL, "full")).saved).toBe(markdown);
  });

  test("tables in lists and quotes keep theirs too", async () => {
    const markdown = "- Item\n\n  <!-- table-widths: 90px 90px -->\n\n  | A | B |\n  | - | - |\n  | 1 | 2 |\n";
    expect(await formatPage(markdown)).toBe(markdown);
  });

  test("a comment that isn't above a table, or isn't valid, stays as it is", async () => {
    for (const markdown of ["<!-- table-widths: 120px -->\n\nText.\n", "<!-- table-widths: wide -->\n\n" + PLAIN]) {
      expect(await formatPage(markdown)).toBe(markdown);
    }
    const editor = await open("<!-- table-widths: wide -->\n\n" + PLAIN);
    expect(tableWidths(editor.view.state.doc.child(1)).layout).toBe("auto");
    await editor.destroy();
  });

  test("setting fixed widths writes the comment", async () => {
    const { ok, saved } = await size(PLAIN, "fixed", [100.4, 210]);
    expect(ok).toBe(true);
    expect(saved).toBe("<!-- table-widths: 100px 210px -->\n\n| A | B |\n| - | - |\n| 1 | 2 |\n");
  });

  test("full width stores proportions", async () => {
    expect((await size(PLAIN, "full", [100, 300])).saved).toBe(`<!-- table-widths: 25% 75% -->\n\n${PLAIN}`);
  });

  test("fit to content removes the widths", async () => {
    expect((await size(FIXED, "auto")).saved).toBe(PLAIN);
    const { saved, table } = await size(FULL, "auto");
    expect(saved).toBe(PLAIN);
    expect(table.style.width).toBe("");
    expect(table.querySelector("colgroup")).toBeNull();
  });

  test("nothing changes when the widths are the same", async () => {
    expect(await size(FIXED, "fixed", [120, 200])).toMatchObject({ ok: false, saved: null });
    expect(await size(PLAIN, "auto")).toMatchObject({ ok: false, saved: null });
    expect(await size(PLAIN, "fixed", [100])).toMatchObject({ ok: false, saved: null });
  });

  test("a column is never narrower than the minimum", async () => {
    expect((await size(PLAIN, "fixed", [10, 100])).saved).toContain(`<!-- table-widths: ${MIN_COLUMN_WIDTH}px 100px -->`);
  });

  test("a width moves with its column", async () => {
    const editor = await open(FIXED);
    cursorIn(editor, "1");
    editor.commands.moveTableLine(editor.commands.tableCellAt()!, "column", 1);
    expect(editor.save()).toBe("<!-- table-widths: 200px 120px -->\n\n| B | A |\n| - | - |\n| 2 | 1 |\n");
    await editor.destroy();
  });

  test("a new column gets a width, and a deleted one takes its width along", async () => {
    const editor = await open(FIXED);
    cursorIn(editor, "1");
    editor.commands.editTable(editor.commands.tableCellAt()!, "columnRight");
    expect(editor.save()).toContain(`<!-- table-widths: 120px ${DEFAULT_COLUMN_WIDTH}px 200px -->`);
    editor.commands.editTable(editor.commands.tableCellAt()!, "deleteColumn");
    expect(editor.save()).toBeNull(); // back to the file as it was
    await editor.destroy();

    // In a full-width table the new column takes an average share.
    const full = await open(FULL);
    cursorIn(full, "2");
    full.commands.editTable(full.commands.tableCellAt()!, "columnRight");
    expect(full.save()).toContain("<!-- table-widths: 26.7% 40% 33.3% -->");
    await full.destroy();
  });

  test("widths stay put through more edits and new rows", async () => {
    const editor = await open(FIXED);
    cursorIn(editor, "1");
    const cell = editor.commands.tableCellAt()!;
    editor.commands.setTableWidths(cell, "fixed", [150, 90]);
    editor.commands.editTable(editor.commands.tableCellAt()!, "rowBelow");
    editor.commands.setTableWidths(editor.commands.tableCellAt()!, "fixed", [160, 80]);
    editor.view.dispatch(editor.view.state.tr.insertText("x"));
    expect(editor.save()).toBe("<!-- table-widths: 160px 80px -->\n\n| A | B |\n| - | - |\n| 1 | 2 |\n| x | |\n");
    await editor.destroy();
  });

  test("undo puts the widths back", async () => {
    const editor = await open(PLAIN);
    cursorIn(editor, "1");
    editor.commands.setTableWidths(editor.commands.tableCellAt()!, "fixed", [80, 90]);
    expect(editor.save()).not.toBeNull();
    undo(editor.view.state, editor.view.dispatch);
    expect(editor.save()).toBeNull();
    await editor.destroy();
  });
});
