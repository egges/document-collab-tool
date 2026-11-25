// A page's properties, under its title, as in Notion: a name and a value
// per line, each value editable in place. Click a name to rename the
// property, change its type or choices, or delete it; "Add a property" adds
// one. The same for every page: a regular page's properties are its own,
// a row's are its database's columns, so changing one there changes it for
// every row (deleting one asks first).
import { ask } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { Plus } from "lucide-react";
import type { CellValue, Column, ColumnChange, PageProperties as Properties } from "./api.ts";
import { ColumnMenu } from "./ColumnMenu.tsx";
import { Cell, TYPE_ICONS } from "./DatabaseCell.tsx";
import { typeLabel } from "./databases.ts";
import { Popover } from "./Popover.tsx";

export interface PropertyActions {
  /** Resolves to the new property's key. */
  add: (name: string) => Promise<string | null>;
  update: (key: string, change: ColumnChange) => void;
  remove: (key: string) => void;
  set: (key: string, value: CellValue | null) => void;
  onError: (message: string) => void;
}

/** A name no other property has: "Property", "Property 2", ... */
export function newPropertyName(columns: Column[]): string {
  const taken = new Set(columns.map((c) => c.name));
  if (!taken.has("Property")) return "Property";
  for (let n = 2; ; n++) if (!taken.has(`Property ${n}`)) return `Property ${n}`;
}

export function PageProperties({
  properties,
  database,
  actions,
}: {
  properties: Properties;
  /** The database's name, when the page is a row of one. */
  database: string | null;
  actions: PropertyActions;
}) {
  const [menu, setMenu] = useState<string | null>(null);

  const add = async () => {
    const key = await actions.add(newPropertyName(properties.columns));
    if (key) setMenu(key);
  };

  const remove = async (column: Column) => {
    if (database !== null) {
      const sure = await ask(
        `Delete “${column.name}” from “${database || "Untitled"}”? It's a column of the database, so every row loses it.`,
        { title: "Delete property", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" },
      );
      if (!sure) return;
    }
    actions.remove(column.id);
  };

  return (
    <section
      className={"page-properties" + (properties.columns.length ? "" : " no-properties")}
      aria-label="Properties"
    >
      {properties.columns.map((column) => (
        <div key={column.id} className="page-property">
          <Popover
            label={`Property ${column.name}`}
            open={menu === column.id}
            onOpenChange={(open) => setMenu(open ? column.id : null)}
            trigger={(toggle, expanded) => (
              <button
                className="page-property-name"
                aria-haspopup="menu"
                aria-expanded={expanded}
                title={`${typeLabel(column.type)} property`}
                onClick={toggle}
              >
                <span className="db-type-icon">{TYPE_ICONS[column.type](14)}</span>
                <span className="db-header-name">{column.name}</span>
              </button>
            )}
          >
            {(close) => (
              <ColumnMenu
                column={column}
                what="property"
                onChange={(change) => actions.update(column.id, change)}
                onClose={close}
                onDelete={() => void remove(column)}
              />
            )}
          </Popover>
          <div className={`db-cell db-field type-${column.type}`}>
            <Cell
              column={column}
              value={properties.values[column.id]}
              onChange={(value) => actions.set(column.id, value)}
              onError={actions.onError}
              onEnter={(from) => from.blur()}
            />
          </div>
        </div>
      ))}
      <button className="page-property-add" onClick={() => void add()}>
        <Plus size={14} aria-hidden /> Add a property
      </button>
    </section>
  );
}
