// What the table view does with cell values and column order, kept apart
// from React so it can be tested. The stored format is in docsync::database.
import type { CellValue, Column, ColumnType, Row } from "./api.ts";

export const COLUMN_TYPES: { type: ColumnType; label: string }[] = [
  { type: "text", label: "Text" },
  { type: "number", label: "Number" },
  { type: "select", label: "Select" },
  { type: "checkbox", label: "Checkbox" },
  { type: "date", label: "Date" },
  { type: "url", label: "URL" },
];

export const typeLabel = (type: ColumnType) => COLUMN_TYPES.find((t) => t.type === type)?.label ?? type;

/** Whether `value` is stored the way a column of `type` stores it. */
export function fits(type: ColumnType, value: unknown): value is CellValue {
  switch (type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "checkbox":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
    default:
      return typeof value === "string" && value !== "";
  }
}

/**
 * A cell as text in an input. A value of another type (after the column's
 * type changed, or a hand edit) shows as it is, so nothing looks lost.
 */
export function cellText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * What typing `text` into a cell of `type` stores: null empties the cell,
 * and text that isn't a valid value gives an error to show.
 */
export function parseCell(type: ColumnType, text: string): { value: CellValue | null } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { value: null };
  switch (type) {
    case "number": {
      const n = Number(trimmed.replace(/,/g, ""));
      return Number.isFinite(n) ? { value: n } : { error: `“${trimmed}” isn't a number.` };
    }
    case "checkbox":
      return { value: ["true", "yes", "1", "x"].includes(trimmed.toLowerCase()) };
    case "date":
      return fits("date", trimmed) ? { value: trimmed } : { error: `“${trimmed}” isn't a date (YYYY-MM-DD).` };
    case "text":
      // Text keeps its spaces; only an all-blank cell is empty.
      return { value: text };
    default:
      return { value: trimmed };
  }
}

export type SortDirection = "asc" | "desc";
export interface Sort {
  column: string;
  direction: SortDirection;
}

/** Empty cells last in either direction; numbers by value, text naturally. */
export function sortRows(rows: Row[], column: Column, direction: SortDirection): Row[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const sign = direction === "asc" ? 1 : -1;
  const empty = (v: unknown) => v === undefined || v === null || v === "";
  return [...rows].sort((a, b) => {
    const x = a.cells[column.id];
    const y = b.cells[column.id];
    if (empty(x) || empty(y)) return empty(x) === empty(y) ? 0 : empty(x) ? 1 : -1;
    if (typeof x === "number" && typeof y === "number") return sign * (x - y);
    if (typeof x === "boolean" && typeof y === "boolean") return sign * (Number(x) - Number(y));
    if (column.type === "select") {
      // In the order of the choices, like Notion.
      const i = column.options.indexOf(String(x));
      const j = column.options.indexOf(String(y));
      if (i !== j) return sign * ((i < 0 ? Infinity : i) - (j < 0 ? Infinity : j) || 0);
    }
    return sign * collator.compare(cellText(x), cellText(y));
  });
}

/**
 * The position that puts the column at `from` at index `to` instead, between
 * its new neighbours, so only that column's position changes. Columns
 * without a position count as one after the one before them.
 */
export function movedPosition(columns: Column[], from: number, to: number): number {
  const positions: number[] = [];
  for (const c of columns) positions.push(c.position ?? (positions.length ? positions[positions.length - 1] + 1 : 0));
  const others = positions.filter((_, i) => i !== from);
  const before = others[to - 1];
  const after = others[to];
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return after - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

/** A name for a new column that no other column has: "Column 2", "Column 3", ... */
export function newColumnName(columns: Column[]): string {
  const taken = new Set(columns.map((c) => c.name));
  for (let n = columns.length + 1; ; n++) if (!taken.has(`Column ${n}`)) return `Column ${n}`;
}

/**
 * A colour (1 to 6) for a select choice: by its place among the column's
 * choices, so the first six differ, or from its text when it isn't one.
 */
export function optionTone(option: string, options: string[]): number {
  const index = options.indexOf(option);
  if (index >= 0) return (index % 6) + 1;
  let hash = 0;
  for (const ch of option) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (hash % 6) + 1;
}
