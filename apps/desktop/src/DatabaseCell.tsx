// A database cell, editable in place: in the table view, and in the board
// view's card dialog. Each column type gets its own control.
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { Calendar, CircleChevronDown, ExternalLink, Hash, Link, SquareCheck, Type } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { CellValue, Column, ColumnType } from "./api.ts";
import { cellText, fits, optionTone, parseCell } from "./databases.ts";

export const TYPE_ICONS: Record<ColumnType, (size: number) => ReactNode> = {
  text: (s) => <Type size={s} aria-hidden />,
  number: (s) => <Hash size={s} aria-hidden />,
  select: (s) => <CircleChevronDown size={s} aria-hidden />,
  checkbox: (s) => <SquareCheck size={s} aria-hidden />,
  date: (s) => <Calendar size={s} aria-hidden />,
  url: (s) => <Link size={s} aria-hidden />,
};

const MISMATCH = "Stored as another type; editing replaces it";

export function Cell({
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
