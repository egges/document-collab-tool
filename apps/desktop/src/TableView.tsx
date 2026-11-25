// A database as a table: a column per column, a row per row, every cell
// editable in place. Click a column's name for its menu (rename, type,
// choices, sort, move, delete). Sorting is a view of this window only; it
// doesn't change the stored order.
//
// It edits nothing itself: every change goes to `actions`, which saves it
// and passes the database back in.
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Calendar,
  CircleChevronDown,
  ExternalLink,
  Hash,
  Link,
  Plus,
  SquareCheck,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { CellValue, Column, ColumnChange, ColumnType, Database } from "./api.ts";
import {
  COLUMN_TYPES,
  type Sort,
  cellText,
  fits,
  movedPosition,
  optionTone,
  parseCell,
  sortRows,
  typeLabel,
} from "./databases.ts";
import { onMenuKeyDown, useDismiss } from "./menu.ts";

export interface TableActions {
  setCell: (row: string, column: string, value: CellValue | null) => void;
  /** Resolves to the new row's id. */
  addRow: () => Promise<string | null>;
  deleteRow: (row: string) => void;
  /** Resolves to the new column's id. */
  addColumn: () => Promise<string | null>;
  updateColumn: (column: string, change: ColumnChange) => void;
  deleteColumn: (column: string) => void;
  onError: (message: string) => void;
}

const TYPE_ICONS: Record<ColumnType, (size: number) => ReactNode> = {
  text: (s) => <Type size={s} aria-hidden />,
  number: (s) => <Hash size={s} aria-hidden />,
  select: (s) => <CircleChevronDown size={s} aria-hidden />,
  checkbox: (s) => <SquareCheck size={s} aria-hidden />,
  date: (s) => <Calendar size={s} aria-hidden />,
  url: (s) => <Link size={s} aria-hidden />,
};

export function TableView({ database, actions }: { database: Database; actions: TableActions }) {
  const [sort, setSort] = useState<Sort | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [focusRow, setFocusRow] = useState<string | null>(null);
  const table = useRef<HTMLTableElement>(null);

  const sortColumn = sort && database.columns.find((c) => c.id === sort.column);
  const rows = useMemo(
    () => (sortColumn && sort ? sortRows(database.rows, sortColumn, sort.direction) : database.rows),
    [database.rows, sortColumn, sort],
  );

  // A new row: put the cursor in its first cell once it's shown.
  useEffect(() => {
    if (!focusRow) return;
    const input = table.current?.querySelector<HTMLElement>(`tr[data-row="${focusRow}"] .db-cell-input`);
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
      <table className="db-table" ref={table}>
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
          Sorted by {sortColumn.name}, {sort.direction === "asc" ? "ascending" : "descending"}, in this window only.{" "}
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
          <ColumnName column={column} onRename={(name) => actions.updateColumn(column.id, { name })} onDone={close} />
          <div className="db-menu-title">Type</div>
          {COLUMN_TYPES.map(({ type, label }) => (
            <button
              key={type}
              role="menuitemradio"
              aria-checked={column.type === type}
              className={"menu-item" + (column.type === type ? " selected" : "")}
              onClick={() => column.type !== type && actions.updateColumn(column.id, { type })}
            >
              <span className="menu-check">{TYPE_ICONS[type](14)}</span>
              <span className="menu-label">{label}</span>
            </button>
          ))}
          {column.type === "select" && (
            <Choices
              options={column.options}
              onChange={(options) => actions.updateColumn(column.id, { options })}
            />
          )}
          <div className="menu-separator" role="separator" />
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
          <div className="menu-separator" role="separator" />
          <MenuItem
            icon={<Trash2 size={14} />}
            label="Delete column"
            danger
            disabled={columns.length === 1}
            title={columns.length === 1 ? "A database keeps at least one column" : undefined}
            onClick={() => {
              close();
              actions.deleteColumn(column.id);
            }}
          />
        </div>
      )}
    </th>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  danger,
  title,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
}) {
  return (
    <button role="menuitem" className={"menu-item" + (danger ? " danger" : "")} disabled={disabled} title={title} onClick={onClick}>
      <span className="menu-check">{icon}</span>
      <span className="menu-label">{label}</span>
    </button>
  );
}

/** The column's name, renamed on Enter or when focus leaves it. */
function ColumnName({ column, onRename, onDone }: { column: Column; onRename: (name: string) => void; onDone: () => void }) {
  const [name, setName] = useState(column.name);
  const commit = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== column.name) onRename(trimmed);
    else setName(column.name);
  };
  return (
    <input
      className="input db-column-name"
      aria-label="Column name"
      value={name}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setName(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          onDone();
        }
      }}
      spellCheck={false}
    />
  );
}

/** A select column's choices: remove one, or type a new one. */
function Choices({ options, onChange }: { options: string[]; onChange: (options: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const choice = draft.trim();
    if (choice && !options.includes(choice)) onChange([...options, choice]);
    setDraft("");
  };
  return (
    <>
      <div className="db-menu-title">Choices</div>
      <div className="db-choices">
        {options.map((option) => (
          <span key={option} className={`db-pill tone-${optionTone(option, options)}`}>
            {option}
            <button
              className="db-pill-remove"
              aria-label={`Remove ${option}`}
              title="Remove this choice (cells keep their value)"
              onClick={() => onChange(options.filter((o) => o !== option))}
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          className="input db-choice-input"
          placeholder="Add a choice"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          onBlur={add}
          spellCheck={false}
        />
      </div>
    </>
  );
}

const MISMATCH = "Stored as another type; editing replaces it";

function Cell({
  column,
  value,
  onChange,
  onError,
  onEnter,
}: {
  column: Column;
  value: unknown;
  onChange: (value: CellValue | null) => void;
  onError: (message: string) => void;
  onEnter: (from: HTMLElement) => void;
}) {
  const empty = value === undefined || value === null;
  const mismatch = !empty && !fits(column.type, value);
  switch (column.type) {
    case "checkbox":
      return (
        <input
          type="checkbox"
          className="db-cell-input db-checkbox"
          aria-label={column.name}
          title={mismatch ? `${MISMATCH}: ${cellText(value)}` : undefined}
          checked={value === true}
          // Unticked is an empty cell, so files only hold what was ticked.
          onChange={(e) => onChange(e.target.checked ? true : null)}
        />
      );
    case "select": {
      const current = empty ? "" : cellText(value);
      const choices = current && !column.options.includes(current) ? [...column.options, current] : column.options;
      return (
        <select
          className={"db-cell-input db-select" + (current ? ` db-pill tone-${optionTone(current, column.options)}` : "")}
          aria-label={column.name}
          value={current}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="" />
          {choices.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }
    case "date":
      if (!mismatch)
        return (
          <input
            type="date"
            className="db-cell-input db-date"
            aria-label={column.name}
            value={empty ? "" : String(value)}
            onChange={(e) => {
              // Typing a date fires a change per part; store complete dates only.
              const v = e.target.value;
              if (v === "" || fits("date", v)) onChange(v || null);
            }}
          />
        );
      break;
  }
  return (
    <TextCell
      column={column}
      value={value}
      mismatch={mismatch}
      onChange={onChange}
      onError={onError}
      onEnter={onEnter}
    />
  );
}

/** Text, numbers and links, and any value of another type than its column's. */
function TextCell({
  column,
  value,
  mismatch,
  onChange,
  onError,
  onEnter,
}: {
  column: Column;
  value: unknown;
  mismatch: boolean;
  onChange: (value: CellValue | null) => void;
  onError: (message: string) => void;
  onEnter: (from: HTMLElement) => void;
}) {
  // What's typed while the cell has focus; null when it hasn't. A reload
  // meanwhile (a sync, the save of another cell) leaves it alone.
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const stored = cellText(value);

  const commit = () => {
    const text = draft;
    setDraft(null);
    if (cancelled.current || text === null || text === stored) {
      cancelled.current = false;
      return;
    }
    const parsed = parseCell(column.type, text);
    if ("error" in parsed) onError(parsed.error);
    else onChange(parsed.value);
  };

  const link = column.type === "url" && !mismatch && stored;
  return (
    <div className="db-text-cell">
      <input
        className={"db-cell-input" + (mismatch && draft === null ? " db-mismatch" : "")}
        aria-label={column.name}
        title={mismatch ? MISMATCH : undefined}
        inputMode={column.type === "number" ? "decimal" : undefined}
        value={draft ?? stored}
        onFocus={() => setDraft(stored)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            const from = e.currentTarget;
            from.blur();
            onEnter(from);
          } else if (e.key === "Escape") {
            e.stopPropagation();
            cancelled.current = true;
            e.currentTarget.blur();
          }
        }}
        spellCheck={column.type === "text"}
      />
      {link && draft === null && (
        <button
          className="icon-button db-open-link"
          title={`Open ${stored}`}
          aria-label="Open link"
          onClick={() => openUrl(stored).catch(() => onError(`Couldn't open ${stored}`))}
        >
          <ExternalLink size={13} />
        </button>
      )}
    </div>
  );
}
