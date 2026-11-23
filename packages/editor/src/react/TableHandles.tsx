import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TableMap } from "@milkdown/kit/prose/tables";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { PageEditor } from "../editor.ts";
import { type TableCell, type TableEdit, type TableLine, canEditTable, canMoveTableLine, tableCellAt } from "../tables.ts";
import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, DotsIcon, PlusIcon, TrashIcon } from "./icons.tsx";

/**
 * How far below and right of a table the pointer can go before its handles
 * hide: the "+" bars are there. Left of it is the block handle's gutter.
 */
const MARGIN = 28;
/** Pixels the pointer moves before a press on a grip becomes a drag. */
const DRAG_THRESHOLD = 4;

type Line = TableLine;

/** A press on a grip: a click (the menu) until it moves, then a drag. */
interface Press {
  line: Line;
  cell: TableCell;
  table: HTMLTableElement;
  /** The menu a click opens. */
  menu: Menu;
  movable: boolean;
  pointerId: number;
  startX: number;
  startY: number;
  started: boolean;
  /** Where it would drop now, as a gap (see `Drag`). */
  gap: number | null;
  ghost: Ghost | null;
  /** Removes the window listeners that follow the pointer. */
  stop: () => void;
}

/** A copy of the dragged row or column that follows the pointer along the table. */
interface Ghost {
  element: HTMLElement;
  /** Where the row or column was, in client coordinates. */
  left: number;
  top: number;
  /** Where the pointer was from its top left. */
  dx: number;
  dy: number;
}

/** A row or column being dragged, and the gap it would drop into. */
interface Drag {
  line: Line;
  cell: TableCell;
  /** Rows or columns before the gap: 0 is before the first. */
  gap: number | null;
}

interface Menu {
  line: Line;
  cell: TableCell;
  left: number;
  top: number;
}

/**
 * Handles on the table under the pointer, as in Notion: a grip on the left
 * of its row and one above its column, each opening a menu to insert or
 * delete, and "+" bars below the table and on its right to add a row or a
 * column at the end.
 */
export function TableHandles({ editor, container }: { editor: PageEditor; container: React.RefObject<HTMLDivElement | null> }) {
  const { view, commands } = editor;
  const [hover, setHover] = useState<TableCell | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const press = useRef<Press | null>(null);
  const hoverRef = useRef(hover);
  hoverRef.current = hover;

  /** Ends a press or drag: removes its listeners and ghost. */
  const endPress = () => {
    const current = press.current;
    press.current = null;
    current?.stop();
    current?.ghost?.element.remove();
    setDrag(null);
    return current;
  };
  useEffect(() => () => void endPress(), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const onMove = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest(".page-table-ui")) return;
      const cellEl = target.closest<HTMLElement>(".ProseMirror td, .ProseMirror th");
      if (cellEl && view.dom.contains(cellEl)) {
        const cell = tableCellAt(view.state, view.posAtDOM(cellEl, 0));
        if (!sameCell(cell, hoverRef.current)) setHover(cell);
        return;
      }
      const current = hoverRef.current;
      const table = current && tableElement(view, current);
      if (table && near(table.getBoundingClientRect(), event.clientX, event.clientY)) return;
      if (current) setHover(null);
    };
    const onLeave = () => setHover(null);
    el.addEventListener("mousemove", onMove);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      el.removeEventListener("mousemove", onMove);
      el.removeEventListener("mouseleave", onLeave);
    };
  }, [container, view]);

  // The table may have changed since the pointer was over it.
  const shown = drag?.cell ?? menu?.cell ?? current(view, hover);
  // The block handle hides meanwhile: next to the row grip it looks like a
  // second one. Moving into the gutter brings it back, to drag the table.
  const showing = !!shown;
  useLayoutEffect(() => {
    container.current?.classList.toggle("page-table-hover", showing);
  }, [container, showing]);
  const box = container.current?.getBoundingClientRect();
  const table = shown && tableElement(view, shown);
  if (!shown || !table || !box) return null;
  const rowEl = table.rows[shown.row];
  const cellEl = rowEl?.cells[shown.col];
  if (!rowEl || !cellEl) return null;
  const t = table.getBoundingClientRect();
  const r = rowEl.getBoundingClientRect();
  const c = cellEl.getBoundingClientRect();

  const edit = (cell: TableCell, change: TableEdit) => {
    commands.editTable(cell, change);
    setHover(null);
    setMenu(null);
  };
  const last = (cell: TableCell, line: Line): TableCell =>
    line === "row" ? { ...cell, row: cell.rows - 1 } : { ...cell, col: cell.cols - 1 };
  // Slim pills centred on the table's left and top borders.
  const rowGrip = { left: t.left - box.left - 5, top: r.top - box.top + r.height / 2 - 11 };
  const columnGrip = { left: c.left - box.left + c.width / 2 - 11, top: t.top - box.top - 5 };
  // A grip opens its menu, or closes it when it's open.
  const toggle = (next: Menu) => setMenu((open) => (open?.line === next.line ? null : next));
  // Keep the editor's selection and focus when a handle is pressed.
  const keepFocus = (event: React.MouseEvent) => event.preventDefault();

  const follow = (event: PointerEvent) => {
    const current = press.current;
    if (!current?.movable) return;
    if (!current.started) {
      if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < DRAG_THRESHOLD) return;
      current.started = true;
      setMenu(null);
      // Offset from where the grip was pressed, so the copy stays under the pointer.
      if (container.current) current.ghost = createGhost(current, container.current, current.startX, current.startY);
    }
    if (current.ghost) moveGhost(current.ghost, current.line, event.clientX, event.clientY);
    current.gap = dropGap(current.table, current, event.clientX, event.clientY);
    setDrag({ line: current.line, cell: current.cell, gap: current.gap });
  };

  const release = () => {
    const current = endPress();
    if (!current) return;
    if (!current.started) return toggle(current.menu);
    setHover(null);
    const to = current.gap === null ? null : destination(current, current.gap);
    if (to !== null) commands.moveTableLine(current.cell, current.line, to);
  };

  // A grip: press and release for its menu, press and move to drag the row
  // or column (not the header row, which stays first). Enter or Space on a
  // focused grip opens the menu too.
  const grip = (line: Line, position: { left: number; top: number }) => {
    const menuAt: Menu =
      line === "row"
        ? { line, cell: shown, left: position.left + 16, top: position.top }
        : { line, cell: shown, left: position.left, top: position.top + 16 };
    const movable = line === "column" || shown.row > 0;
    return {
      className: `page-table-grip ${line}${movable ? "" : " fixed"}${drag?.line === line ? " dragging" : ""}`,
      style: position,
      "aria-label": line === "row" ? "Row" : "Column",
      title: movable
        ? `Drag to move, click for more`
        : "The header row stays first. Click for more",
      "aria-haspopup": "menu" as const,
      "aria-expanded": menu?.line === line,
      onMouseDown: keepFocus,
      onClick: (event: React.MouseEvent) => {
        if (event.detail === 0) toggle(menuAt);
      },
      // Once pressed, the pointer is followed on the window, so the drag
      // doesn't depend on the grip keeping the pointer captured.
      onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        endPress();
        const pointerId = event.pointerId;
        const onMove = (e: PointerEvent) => e.pointerId === pointerId && follow(e);
        const onUp = (e: PointerEvent) => e.pointerId === pointerId && release();
        const onCancel = (e: PointerEvent) => e.pointerId === pointerId && endPress();
        const onKey = (e: KeyboardEvent) => {
          if (e.key !== "Escape" || !press.current?.started) return;
          e.preventDefault();
          e.stopPropagation();
          endPress();
        };
        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup", onUp, true);
        window.addEventListener("pointercancel", onCancel, true);
        window.addEventListener("keydown", onKey, true);
        press.current = {
          line,
          cell: shown,
          table,
          menu: menuAt,
          movable,
          pointerId,
          startX: event.clientX,
          startY: event.clientY,
          started: false,
          gap: null,
          ghost: null,
          stop: () => {
            window.removeEventListener("pointermove", onMove, true);
            window.removeEventListener("pointerup", onUp, true);
            window.removeEventListener("pointercancel", onCancel, true);
            window.removeEventListener("keydown", onKey, true);
          },
        };
      },
    };
  };

  return (
    <div className="page-table-ui">
      <button type="button" {...grip("row", rowGrip)}>
        <DotsIcon size={12} />
      </button>
      <button type="button" {...grip("column", columnGrip)}>
        <DotsIcon size={12} />
      </button>
      {drag && <DragMarks table={table} box={box} drag={drag} />}
      <button
        type="button"
        className="page-table-add row"
        style={{ left: t.left - box.left, top: t.bottom - box.top + 2, width: t.width }}
        aria-label="Add a row"
        title="Add a row"
        onMouseDown={keepFocus}
        onClick={() => edit(last(shown, "row"), "rowBelow")}
      >
        <PlusIcon size={12} />
      </button>
      <button
        type="button"
        className="page-table-add column"
        style={{ left: t.right - box.left + 2, top: t.top - box.top, height: t.height }}
        aria-label="Add a column"
        title="Add a column"
        onMouseDown={keepFocus}
        onClick={() => edit(last(shown, "column"), "columnRight")}
      >
        <PlusIcon size={12} />
      </button>
      {menu && <TableMenu menu={menu} onEdit={(change) => edit(menu.cell, change)} onClose={() => setMenu(null)} />}
    </div>
  );
}

/**
 * Copies the row, or the column's cells, into a faded table that follows
 * the pointer: inside the editor's container, so the page's styles apply,
 * with each cell as wide as the original.
 */
function createGhost(press: Press, container: HTMLElement, x: number, y: number): Ghost | null {
  const { table, line, cell } = press;
  const rows = line === "row" ? [table.rows[cell.row]] : [...table.rows];
  if (!rows[0]) return null;
  const copy = table.cloneNode(false) as HTMLTableElement;
  const body = document.createElement("tbody");
  let first: DOMRect | null = null;
  let width = 0;
  for (const row of rows) {
    const cells = line === "row" ? [...row.cells] : [row.cells[cell.col]].filter(Boolean);
    const rowCopy = row.cloneNode(false) as HTMLTableRowElement;
    for (const original of cells) {
      const rect = original.getBoundingClientRect();
      first ??= rect;
      const cellCopy = original.cloneNode(true) as HTMLElement;
      cellCopy.style.width = `${rect.width}px`;
      cellCopy.style.boxSizing = "border-box";
      rowCopy.append(cellCopy);
    }
    body.append(rowCopy);
    width = line === "row" ? row.getBoundingClientRect().width : (first?.width ?? 0);
  }
  copy.append(body);
  copy.style.width = `${width}px`;
  const content = document.createElement("div");
  content.className = "ProseMirror";
  content.append(copy);
  const ghost = document.createElement("div");
  ghost.className = "page-block-ghost page-table-ghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.append(content);
  container.append(ghost);
  const origin = line === "row" ? rows[0].getBoundingClientRect() : (first ?? table.getBoundingClientRect());
  const result = { element: ghost, left: origin.left, top: origin.top, dx: x - origin.left, dy: y - origin.top };
  moveGhost(result, line, x, y);
  return result;
}

/** A row's copy moves up and down only, a column's left and right, so it stays lined up with the table. */
function moveGhost(ghost: Ghost, line: Line, x: number, y: number) {
  const left = line === "row" ? ghost.left : x - ghost.dx;
  const top = line === "row" ? y - ghost.dy : ghost.top;
  ghost.element.style.transform = `translate(${left}px, ${top}px)`;
}

/** Where the dragged row or column would end up, as an index; null for where it is. */
function destination(press: { line: Line; cell: TableCell }, gap: number): number | null {
  const from = press.line === "row" ? press.cell.row : press.cell.col;
  const to = gap > from ? gap - 1 : gap;
  return canMoveTableLine(press.cell, press.line, to) ? to : null;
}

/** The rows' or columns' edges along the drag: top or left edges, then the last bottom or right. */
function edges(table: HTMLTableElement, line: Line): { start: number; end: number }[] {
  const parts = line === "row" ? [...table.rows] : [...(table.rows[0]?.cells ?? [])];
  return parts.map((part) => {
    const rect = part.getBoundingClientRect();
    return line === "row" ? { start: rect.top, end: rect.bottom } : { start: rect.left, end: rect.right };
  });
}

/** The gap nearest the pointer: how many rows or columns come before it. Never above the header row. */
function dropGap(table: HTMLTableElement, press: { line: Line; cell: TableCell }, x: number, y: number): number | null {
  const parts = edges(table, press.line);
  if (!parts.length) return null;
  const at = press.line === "row" ? y : x;
  let gap = parts.filter((p) => (p.start + p.end) / 2 < at).length;
  if (press.line === "row") gap = Math.max(1, gap);
  return destination(press, gap) === null ? null : gap;
}

/** While dragging: the row or column being moved, shaded, and a line where it would go. */
function DragMarks({ table, box, drag }: { table: HTMLTableElement; box: DOMRect; drag: Drag }) {
  const t = table.getBoundingClientRect();
  const parts = edges(table, drag.line);
  const index = drag.line === "row" ? drag.cell.row : drag.cell.col;
  const source = parts[index];
  if (!source) return null;
  const row = drag.line === "row";
  const shade = row
    ? { left: t.left - box.left, top: source.start - box.top, width: t.width, height: source.end - source.start }
    : { left: source.start - box.left, top: t.top - box.top, width: source.end - source.start, height: t.height };
  let line: React.CSSProperties | null = null;
  if (drag.gap !== null) {
    const edge = drag.gap < parts.length ? parts[drag.gap].start : parts[parts.length - 1].end;
    line = row
      ? { left: t.left - box.left, top: edge - box.top - 1, width: t.width, height: 3 }
      : { left: edge - box.left - 1, top: t.top - box.top, width: 3, height: t.height };
  }
  return (
    <>
      <div className="page-table-dragged" style={shade} />
      {line && <div className="page-table-drop" style={line} />}
    </>
  );
}

interface Action {
  edit: TableEdit;
  label: string;
  icon: React.ReactNode;
  danger?: boolean;
}

const ACTIONS: Record<Line, Action[]> = {
  row: [
    { edit: "rowAbove", label: "Insert above", icon: <ArrowUpIcon /> },
    { edit: "rowBelow", label: "Insert below", icon: <ArrowDownIcon /> },
    { edit: "deleteRow", label: "Delete row", icon: <TrashIcon />, danger: true },
  ],
  column: [
    { edit: "columnLeft", label: "Insert left", icon: <ArrowLeftIcon /> },
    { edit: "columnRight", label: "Insert right", icon: <ArrowRightIcon /> },
    { edit: "deleteColumn", label: "Delete column", icon: <TrashIcon />, danger: true },
  ],
};

/** Why an action is greyed out, as its tooltip. */
function whyNot(cell: TableCell, edit: TableEdit): string | undefined {
  if (canEditTable(cell, edit)) return undefined;
  if (edit === "rowAbove") return "The first row is the table's header";
  if (cell.row === 0) return "The first row is the table's header";
  return "A table keeps at least one row under its header";
}

function TableMenu({ menu, onEdit, onClose }: { menu: Menu; onEdit: (edit: TableEdit) => void; onClose: () => void }) {
  const element = useRef<HTMLDivElement>(null);
  const actions = ACTIONS[menu.line];
  const enabled = (i: number) => canEditTable(menu.cell, actions[i].edit);
  const [active, setActive] = useState(() => Math.max(0, actions.findIndex((_, i) => enabled(i))));

  useEffect(() => {
    element.current?.focus();
  }, []);
  useEffect(() => {
    // Clicking elsewhere closes it; its grip closes it itself (see toggle).
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!element.current?.contains(target) && !target.closest?.(".page-table-grip")) onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [onClose]);

  const step = (by: number) => {
    let i = active;
    for (let n = 0; n < actions.length; n++) {
      i = (i + by + actions.length) % actions.length;
      if (enabled(i)) return setActive(i);
    }
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case "ArrowDown":
        step(1);
        break;
      case "ArrowUp":
        step(-1);
        break;
      case "Enter":
      case " ":
        if (enabled(active)) onEdit(actions[active].edit);
        break;
      case "Escape":
        onClose();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      ref={element}
      className="page-menu page-block-menu page-table-menu"
      style={{ left: menu.left, top: menu.top }}
      role="menu"
      aria-label={menu.line === "row" ? "Row" : "Column"}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {actions.map((action, i) => (
        <button
          key={action.edit}
          type="button"
          role="menuitem"
          className={[i === active ? "active" : "", action.danger ? "danger" : ""].join(" ").trim() || undefined}
          disabled={!enabled(i)}
          title={whyNot(menu.cell, action.edit)}
          onMouseEnter={() => enabled(i) && setActive(i)}
          onClick={() => onEdit(action.edit)}
        >
          <span className="page-block-menu-icon">{action.icon}</span>
          <span className="page-menu-label">{action.label}</span>
        </button>
      ))}
    </div>
  );
}

function sameCell(a: TableCell | null, b: TableCell | null): boolean {
  return a === b || (!!a && !!b && a.table === b.table && a.row === b.row && a.col === b.col && a.rows === b.rows && a.cols === b.cols);
}

/** `cell` as the document is now, or null if its table is gone or changed shape. */
function current(view: EditorView, cell: TableCell | null): TableCell | null {
  if (!cell) return null;
  const node = view.state.doc.nodeAt(cell.table);
  if (node?.type.name !== "table") return null;
  const map = TableMap.get(node);
  return map.height === cell.rows && map.width === cell.cols ? cell : null;
}

function tableElement(view: EditorView, cell: TableCell): HTMLTableElement | null {
  const dom = view.nodeDOM(cell.table);
  if (dom instanceof HTMLTableElement) return dom;
  return dom instanceof HTMLElement ? dom.querySelector("table") : null;
}

/** Over the table, or just below or right of it, where the "+" bars are. */
function near(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right + MARGIN && y >= rect.top && y <= rect.bottom + MARGIN;
}
