// A column's menu: rename it, change its type, edit a select's choices, and
// delete it, with room for more items (sorting and moving, in the table).
// The table's column headers and a page's properties use it; on a page a
// column is called a property.
import { type ReactNode, useState } from "react";
import { Trash2, X } from "lucide-react";
import type { Column, ColumnChange } from "./api.ts";
import { TYPE_ICONS } from "./DatabaseCell.tsx";
import { COLUMN_TYPES, optionTone } from "./databases.ts";

export function ColumnMenu({
  column,
  what,
  onChange,
  onClose,
  onDelete,
  canDelete = true,
  cannotDelete,
  children,
}: {
  column: Column;
  /** "column" or "property", for the labels. */
  what: string;
  onChange: (change: ColumnChange) => void;
  onClose: () => void;
  onDelete: () => void;
  canDelete?: boolean;
  /** Why it can't be deleted. */
  cannotDelete?: string;
  /** Items between the types and "Delete". */
  children?: ReactNode;
}) {
  return (
    <>
      <ColumnName column={column} label={`${what[0].toUpperCase()}${what.slice(1)} name`} onRename={(name) => onChange({ name })} onDone={onClose} />
      <div className="db-menu-title">Type</div>
      {COLUMN_TYPES.map(({ type, label }) => (
        <button
          key={type}
          role="menuitemradio"
          aria-checked={column.type === type}
          className={"menu-item" + (column.type === type ? " selected" : "")}
          onClick={() => column.type !== type && onChange({ type })}
        >
          <span className="menu-check">{TYPE_ICONS[type](14)}</span>
          <span className="menu-label">{label}</span>
        </button>
      ))}
      {column.type === "select" && <Choices options={column.options} onChange={(options) => onChange({ options })} />}
      <div className="menu-separator" role="separator" />
      {children}
      {children && <div className="menu-separator" role="separator" />}
      <MenuItem
        icon={<Trash2 size={14} />}
        label={`Delete ${what}`}
        danger
        disabled={!canDelete}
        title={canDelete ? undefined : cannotDelete}
        onClick={() => {
          onClose();
          onDelete();
        }}
      />
    </>
  );
}

export function MenuItem({
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
function ColumnName({
  column,
  label,
  onRename,
  onDone,
}: {
  column: Column;
  label: string;
  onRename: (name: string) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(column.name);
  const commit = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== column.name) onRename(trimmed);
    else setName(column.name);
  };
  return (
    <input
      className="input db-column-name"
      aria-label={label}
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
