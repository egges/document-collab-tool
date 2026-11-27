// A database as a table: a column per column, a row per row, every cell
// editable in place. Click a column's name for its menu (rename, type,
// choices, sort, move, delete). Sorting never changes the stored order: it
// belongs to this window, or to the page's view when one passes `sort`.
//
// It edits nothing itself: every change goes to `actions`, which saves it
// and passes the database back in.
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Maximize2, Plus, Trash2, X } from "lucide-react";
import type { Column, Database } from "./api.ts";
import { ColumnMenu, MenuItem } from "./ColumnMenu.tsx";
import { Cell, TYPE_ICONS } from "./DatabaseCell.tsx";
import { type Sort, movedPosition, sortRows, typeLabel } from "./databases.ts";
import { onMenuKeyDown, useDismiss } from "./menu.ts";
import type { DatabaseActions } from "./useDatabase.ts";

export type TableActions = DatabaseActions;


export function TableView({
  database,
  actions,
  sort: viewSort,
  onSort,
  onOpenRow,
}: {
  database: Database;
  actions: TableActions;
  /** The sort kept on a page's view, for everyone; without `onSort`, it's this window's own. */
  sort?: Sort | null;
  onSort?: (sort: Sort | null) => void;
  /** Open a row as a page; without it, rows can't be opened (the developer panel). */
  onOpenRow?: (row: string) => void;
}) {
  const [ownSort, setOwnSort] = useState<Sort | null>(null);
  const sort = onSort ? (viewSort ?? null) : ownSort;
  const setSort = onSort ?? setOwnSort;
  const [menu, setMenu] = useState<string | null>(null);
  const [focusRow, setFocusRow] = useState<string | null>(null);
  const table = useRef<HTMLTableElement>(null);

  const sortColumn = sort && database.columns.find((c) => c.id === sort.column);
  const rows = useMemo(
    () => (sortColumn && sort ? sortRows(database.rows, sortColumn, sort.direction) : database.rows),
    [database.rows, sortColumn, sort],
  );

  // A new row: put the cursor in its name once it's shown, wherever that column is.
  useEffect(() => {
    if (!focusRow) return;
    const tr = table.current?.querySelector(`tr[data-row="${focusRow}"]`);
    const input =
      tr?.querySelector<HTMLElement>(".type-title .db-cell-input") ?? tr?.querySelector<HTMLElement>(".db-cell-input");
    if (input) {
      input.focus();
      setFocusRow(null);
    }
  }, [focusRow, rows]);

  const addRow = async () => {
    const id = await actions.addRow();
    if (id) setFocusRow(id);
  };

  const addColumn = async () => {
    const id = await actions.addColumn();
    if (id) setMenu(id);
  };

  /** Enter moves down a row in the same column, as in a spreadsheet. */
  const moveDown = (from: HTMLElement) => {
    const cell = from.closest("td");
    const row = cell?.parentElement;
    if (!cell || !row) return;
    const next = row.nextElementSibling?.children[cell.cellIndex]?.querySelector<HTMLElement>(".db-cell-input");
    next?.focus();
  };

  return (
    <div className="db-table-wrap">
      <table className={"db-table" + (onOpenRow ? " openable" : "")} ref={table}>
        <thead>
          <tr>
            <th className="db-gutter" aria-label="Row" />
            {database.columns.map((column, index) => (
              <ColumnHeader
                key={column.id}
                column={column}
                index={index}
                columns={database.columns}
                sort={sort?.column === column.id ? sort.direction : null}
                open={menu === column.id}
                onOpen={(open) => setMenu(open ? column.id : null)}
                onSort={(direction) => setSort(direction ? { column: column.id, direction } : null)}
                actions={actions}
              />
            ))}
            <th className="db-add-column">
              <button className="icon-button" title="Add a column" aria-label="Add a column" onClick={() => void addColumn()}>
                <Plus size={15} />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.id} data-row={row.id}>
              <td className="db-gutter">
                <span className="db-row-number">{index + 1}</span>
                {onOpenRow && (
                  <button
                    className="icon-button db-row-open"
                    title="Open as a page"
                    aria-label={`Open row ${index + 1}`}
                    onClick={() => onOpenRow(row.id)}
                  >
                    <Maximize2 size={13} />
                  </button>
                )}
                <button
                  className="icon-button danger db-row-delete"
                  title="Delete this row"
                  aria-label={`Delete row ${index + 1}`}
                  onClick={() => actions.deleteRow(row.id)}
                >
                  <Trash2 size={13} />
                </button>
              </td>
              {database.columns.map((column) => (
                <td key={column.id} className={`db-cell type-${column.type}`}>
                  <Cell
                    column={column}
                    value={row.cells[column.id]}
                    onChange={(value) => actions.setCell(row.id, column.id, value)}
                    onError={actions.onError}
                    onEnter={moveDown}
                  />
                </td>
              ))}
              <td className="db-filler" />
            </tr>
          ))}
        </tbody>
      </table>
      <button className="db-add-row" onClick={() => void addRow()}>
        <Plus size={14} aria-hidden /> New row
      </button>
      {sortColumn && sort && (
        <p className="db-sort-note muted">
          Sorted by {sortColumn.name}, {sort.direction === "asc" ? "ascending" : "descending"}
          {onSort ? "." : ", in this window only."}{" "}
          <button className="link" onClick={() => setSort(null)}>
            Clear
          </button>
        </p>
      )}
    </div>
  );
}

function ColumnHeader({
  column,
  index,
  columns,
  sort,
  open,
  onOpen,
  onSort,
  actions,
}: {
  column: Column;
  index: number;
  columns: Column[];
  sort: Sort["direction"] | null;
  open: boolean;
  onOpen: (open: boolean) => void;
  onSort: (direction: Sort["direction"] | null) => void;
  actions: TableActions;
}) {
  const root = useRef<HTMLTableCellElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const close = useCallback(() => onOpen(false), [onOpen]);
  useDismiss(root, open, close);

  // The table scrolls sideways, so the menu is fixed to the window, under the header.
  useLayoutEffect(() => {
    if (!open || !trigger.current) return setPlace(null);
    const r = trigger.current.getBoundingClientRect();
    setPlace({ left: Math.min(r.left, window.innerWidth - 260), top: r.bottom + 4 });
  }, [open]);

  const move = (to: number) => {
    actions.updateColumn(column.id, { position: movedPosition(columns, index, to) });
    onOpen(false);
  };

  return (
    <th ref={root} className={`db-header type-${column.type}`}>
      <button
        ref={trigger}
        className="db-header-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${typeLabel(column.type)} column`}
        onClick={() => onOpen(!open)}
      >
        <span className="db-type-icon">{TYPE_ICONS[column.type](13)}</span>
        <span className="db-header-name">{column.name}</span>
        {sort === "asc" && <ArrowUp size={12} aria-label="Sorted ascending" />}
        {sort === "desc" && <ArrowDown size={12} aria-label="Sorted descending" />}
      </button>
      {open && place && (
        <div
          className="menu db-column-menu"
          role="menu"
          aria-label={`Column ${column.name}`}
          style={place}
          onKeyDown={(e) => {
            // Arrow keys move through the items, but not out of the name or a choice being typed.
            if (!(e.target instanceof HTMLInputElement)) onMenuKeyDown(e);
          }}
        >
          <ColumnMenu
            column={column}
            what="column"
            onChange={(change) => actions.updateColumn(column.id, change)}
            onClose={close}
            onDelete={() => actions.deleteColumn(column.id)}
          >
            <MenuItem icon={<ArrowUp size={14} />} label="Sort ascending" onClick={() => (onSort("asc"), close())} />
            <MenuItem icon={<ArrowDown size={14} />} label="Sort descending" onClick={() => (onSort("desc"), close())} />
            {sort && <MenuItem icon={<X size={14} />} label="Clear sort" onClick={() => (onSort(null), close())} />}
            <MenuItem icon={<ArrowLeft size={14} />} label="Move left" disabled={index === 0} onClick={() => move(index - 1)} />
            <MenuItem
              icon={<ArrowRight size={14} />}
              label="Move right"
              disabled={index === columns.length - 1}
              onClick={() => move(index + 1)}
            />
          </ColumnMenu>
        </div>
      )}
    </th>
  );
}
