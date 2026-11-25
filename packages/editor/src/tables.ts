// Adding and removing table rows and columns. Kept free of any UI framework,
// like commands.ts; the row and column grips (react/TableHandles.tsx) call
// these.
//
// A GFM table always has one header row and at least one row below it
// (the schema is `table_header_row table_row+`), so nothing goes above the
// header, the header itself isn't deleted, and neither is the last row
// under it. Deleting the only column deletes the table.
//
// Column widths (see "Column widths" below) are stored on the cells, in
// prosemirror-tables' own `colwidth` attribute, so they move along when a
// column moves. Every cell of a column has the same width: prosemirror-tables
// fixes any that differ, to the most common one. tableView.ts writes them to
// Markdown.
import type { Node } from "@milkdown/kit/prose/model";
import { type Command, type EditorState, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import {
  TableMap,
  addColumnAfter,
  addColumnBefore,
  cellAround,
  deleteColumn,
  deleteRow,
  deleteTable,
  moveTableColumn,
  moveTableRow,
} from "@milkdown/kit/prose/tables";

/** A cell of a table, and the table's size. */
export interface TableCell {
  /** Position of the table node. */
  table: number;
  /** Row, counting the header row as 0. */
  row: number;
  col: number;
  rows: number;
  cols: number;
}

/** A row or a column. */
export type TableLine = "row" | "column";

export type TableEdit = "rowAbove" | "rowBelow" | "columnLeft" | "columnRight" | "deleteRow" | "deleteColumn";

/** The table cell containing `pos` (by default the cursor), if any. */
export function tableCellAt(state: EditorState, pos = state.selection.from): TableCell | null {
  const $cell = cellAround(state.doc.resolve(pos));
  if (!$cell) return null;
  const table = $cell.node(-1);
  const start = $cell.start(-1);
  const map = TableMap.get(table);
  const rect = map.findCell($cell.pos - start);
  return { table: start - 1, row: rect.top, col: rect.left, rows: map.height, cols: map.width };
}

/** Whether `edit` can be made at `cell`; see the rules at the top. */
export function canEditTable(cell: TableCell, edit: TableEdit): boolean {
  switch (edit) {
    case "rowAbove":
      return cell.row > 0;
    case "deleteRow":
      return cell.row > 0 && cell.rows > 2;
    default:
      return true;
  }
}

/**
 * Makes `edit` at `cell`, as one transaction (one undo step). The cursor goes
 * into the new row or column, or stays in the same row or column after a
 * delete. Null when the edit isn't allowed or the table changed meanwhile.
 */
export function editTable(state: EditorState, cell: TableCell, edit: TableEdit): Transaction | null {
  const table = state.doc.nodeAt(cell.table);
  if (!table || table.type.name !== "table" || !canEditTable(cell, edit)) return null;
  const map = TableMap.get(table);
  if (cell.row >= map.height || cell.col >= map.width) return null;

  // prosemirror-tables commands work on the cell with the cursor in it.
  const tr = state.tr.setSelection(TextSelection.near(state.doc.resolve(cellPos(cell.table, table, cell.row, cell.col) + 1)));
  const run = (command: Command) => {
    const at = state.apply(tr);
    let made: Transaction | null = null;
    command(at, (t) => (made = t));
    if (!made) return false;
    for (const step of (made as Transaction).steps) tr.step(step);
    return true;
  };

  let target: [row: number, col: number] | null;
  switch (edit) {
    case "rowAbove":
    case "rowBelow": {
      const row = edit === "rowAbove" ? cell.row : cell.row + 1;
      tr.insert(rowPos(cell.table, table, row), newRow(table));
      target = [row, cell.col];
      break;
    }
    case "columnLeft":
      if (!run(addColumnBefore)) return null;
      unalign(tr, cell.table, cell.col);
      sizeNewColumn(tr, cell.table, table, cell.col);
      target = [cell.row, cell.col];
      break;
    case "columnRight":
      if (!run(addColumnAfter)) return null;
      unalign(tr, cell.table, cell.col + 1);
      sizeNewColumn(tr, cell.table, table, cell.col + 1);
      target = [cell.row, cell.col + 1];
      break;
    case "deleteRow":
      if (!run(deleteRow)) return null;
      target = [Math.min(cell.row, map.height - 2), cell.col];
      break;
    case "deleteColumn":
      if (map.width === 1) {
        if (!run(deleteTable)) return null;
        target = null;
      } else {
        if (!run(deleteColumn)) return null;
        target = [cell.row, Math.min(cell.col, map.width - 2)];
      }
      break;
  }

  if (target) {
    const after = tr.doc.nodeAt(cell.table)!;
    tr.setSelection(TextSelection.near(tr.doc.resolve(cellPos(cell.table, after, ...target) + 1)));
  }
  return tr.scrollIntoView();
}

/**
 * Whether the row or column through `cell` can move to index `to`. The
 * header row stays first: it doesn't move, and nothing moves above it.
 */
export function canMoveTableLine(cell: TableCell, line: TableLine, to: number): boolean {
  if (line === "column") return to >= 0 && to < cell.cols && to !== cell.col;
  return cell.row > 0 && to >= 1 && to < cell.rows && to !== cell.row;
}

/**
 * Moves the row or column through `cell` so it ends up at index `to`, as one
 * transaction, with the cursor in the cell that moved. Null when it can't
 * move there or the table changed meanwhile.
 */
export function moveTableLine(state: EditorState, cell: TableCell, line: TableLine, to: number): Transaction | null {
  const table = state.doc.nodeAt(cell.table);
  if (!table || table.type.name !== "table" || !canMoveTableLine(cell, line, to)) return null;
  const map = TableMap.get(table);
  if (map.height !== cell.rows || map.width !== cell.cols) return null;
  const from = line === "row" ? cell.row : cell.col;
  const inside = cellPos(cell.table, table, cell.row, cell.col) + 1;
  const move = line === "row" ? moveTableRow : moveTableColumn;
  let made: Transaction | null = null;
  move({ from, to, select: false, pos: inside })(state, (tr) => (made = tr));
  if (!made) return null;
  const tr = made as Transaction;
  const [row, col] = line === "row" ? [to, cell.col] : [cell.row, to];
  tr.setSelection(TextSelection.near(tr.doc.resolve(cellPos(cell.table, tr.doc.nodeAt(cell.table)!, row, col) + 1)));
  return tr.scrollIntoView();
}

/** Position of the cell at `row`, `col` in the table node at `tablePos`. */
export function cellPos(tablePos: number, table: Node, row: number, col: number): number {
  const map = TableMap.get(table);
  return tablePos + 1 + map.map[row * map.width + col];
}

/**
 * A new column has no alignment (`| - |`), as when written by hand; its
 * cells would otherwise be left-aligned, the schema's default.
 */
function unalign(tr: Transaction, tablePos: number, col: number) {
  const table = tr.doc.nodeAt(tablePos)!;
  const map = TableMap.get(table);
  for (let row = 0; row < map.height; row++) {
    const pos = cellPos(tablePos, table, row, col);
    tr.setNodeAttribute(pos, "alignment", null);
  }
}

function rowPos(tablePos: number, table: Node, row: number): number {
  let pos = tablePos + 1;
  for (let i = 0; i < row; i++) pos += table.child(i).nodeSize;
  return pos;
}

/** An empty body row, each cell aligned like its column's header. */
function newRow(table: Node): Node {
  const { schema } = table.type;
  const cells: Node[] = [];
  table.firstChild!.forEach((header) => {
    cells.push(schema.nodes.table_cell.createAndFill({ alignment: header.attrs.alignment })!);
  });
  return schema.nodes.table_row.create(null, cells);
}

// --- Column widths -----------------------------------------------------------
//
// A table is sized in one of three ways:
//   auto   columns follow their content (no widths stored; plain Markdown)
//   fixed  each column has a width in pixels; the table is as wide as their sum
//   full   the table spans the page; widths are percentages of it, or none,
//          in which case the browser shares the width by content
//
// Columns "fit their content" when no widths are stored: auto, or full
// without widths.

export type TableLayout = "auto" | "fixed" | "full";

export interface TableWidths {
  layout: TableLayout;
  /** One per column: pixels when fixed, percentages when full; all null when the columns fit their content. */
  widths: (number | null)[];
}

/** Whether the columns follow their content: no widths are stored. */
export const fitsContent = ({ widths }: TableWidths): boolean => widths.every((w) => w === null);

/** The narrowest a column can be dragged. */
export const MIN_COLUMN_WIDTH = 48;
/** The width of a column added to a fixed-width table. */
export const DEFAULT_COLUMN_WIDTH = 140;

/**
 * How `table` is sized. A column without a width in a fixed or full table
 * (added by hand in the Markdown, say) gets a default one.
 */
export function tableWidths(table: Node): TableWidths {
  const stored: (number | null)[] = [];
  table.firstChild?.forEach((cell) => {
    const width = cell.attrs.colwidth?.[0];
    stored.push(typeof width === "number" && width > 0 ? width : null);
  });
  const known = stored.filter((w): w is number => w !== null);
  if (table.attrs.full) {
    if (!known.length) return { layout: "full", widths: stored };
    const fallback = known.reduce((a, b) => a + b, 0) / known.length;
    return { layout: "full", widths: stored.map((w) => w ?? fallback) };
  }
  if (!known.length) return { layout: "auto", widths: stored.map(() => null) };
  return { layout: "fixed", widths: stored.map((w) => w ?? DEFAULT_COLUMN_WIDTH) };
}

/**
 * Sizes the table at `tablePos`, as one transaction. `widths` has one entry
 * per column: pixels for "fixed", and for "full" any relative sizes (they're
 * stored as percentages), or none to share the width by content. Ignored for
 * "auto". Null when nothing changes or the widths don't fit the table.
 */
export function setTableWidths(state: EditorState, tablePos: number, layout: TableLayout, widths: number[] = []): Transaction | null {
  const table = state.doc.nodeAt(tablePos);
  if (!table || table.type.name !== "table") return null;
  const header = table.firstChild!;
  let stored: (number | null)[];
  if (layout === "auto" || (layout === "full" && !widths.length)) {
    stored = [];
    header.forEach(() => stored.push(null));
  } else {
    if (widths.length !== header.childCount || widths.some((w) => !(w > 0))) return null;
    if (layout === "fixed") {
      stored = widths.map((w) => Math.max(MIN_COLUMN_WIDTH, Math.round(w)));
    } else {
      const total = widths.reduce((a, b) => a + b, 0);
      stored = widths.map((w) => Math.round((w / total) * 1000) / 10);
    }
  }
  const tr = state.tr;
  const full = layout === "full";
  if (!!table.attrs.full !== full) tr.setNodeAttribute(tablePos, "full", full);
  stored.forEach((width, col) => setColumnWidth(tr, tablePos, table, col, width));
  return tr.docChanged ? tr : null;
}

/** Gives a column just added to a sized table a width: the default, or in a full table the average. */
function sizeNewColumn(tr: Transaction, tablePos: number, before: Node, col: number) {
  const sized = tableWidths(before);
  const { layout, widths } = sized;
  if (fitsContent(sized)) return;
  const width =
    layout === "fixed"
      ? DEFAULT_COLUMN_WIDTH
      : Math.round(((widths as number[]).reduce((a, b) => a + b, 0) / widths.length) * 10) / 10;
  setColumnWidth(tr, tablePos, tr.doc.nodeAt(tablePos)!, col, width);
}

/** Gives every cell in column `col` the width `width`, leaving cells that have it. */
function setColumnWidth(tr: Transaction, tablePos: number, table: Node, col: number, width: number | null) {
  const map = TableMap.get(table);
  for (let row = 0; row < map.height; row++) {
    const pos = cellPos(tablePos, table, row, col);
    const cell = table.nodeAt(pos - tablePos - 1)!;
    const now = cell.attrs.colwidth?.[0] ?? null;
    if (now !== width) tr.setNodeAttribute(pos, "colwidth", width === null ? null : [width]);
  }
}
