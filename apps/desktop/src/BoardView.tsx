// A database as a board: a lane per choice of a select column (or checked
// and not, for a checkbox column), a card per row. Drag a card to another
// lane to change its value; click it to open the row as a page. Which column the
// board groups by is kept on the page's view (DatabasePageView.tsx).
//
// Like TableView, it edits nothing itself: every change goes to `actions`.
import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from "react";
import { Check, Columns3, Plus } from "lucide-react";
import type { Column, Database, Row, View } from "./api.ts";
import { type Lane, boardColumn, cardFields, fieldText, lanes as toLanes, titleColumn } from "./boards.ts";
import { TYPE_ICONS } from "./DatabaseCell.tsx";
import { cellText, optionTone, sortRows } from "./databases.ts";
import type { DatabaseActions } from "./useDatabase.ts";

/** A card being dragged: where it came from, where the pointer is, and the lane under it. */
interface Drag {
  row: string;
  from: string;
  /** The pointer, and where on the card it grabbed it. */
  x: number;
  y: number;
  dx: number;
  dy: number;
  width: number;
  over: string | null;
}

/** How far the pointer moves before a press on a card becomes a drag. */
const DRAG_DISTANCE = 4;

export function BoardView({
  database,
  view,
  actions,
  onGroupBy,
  onOpenRow,
}: {
  database: Database;
  view: View;
  actions: DatabaseActions;
  onGroupBy: (column: string) => void;
  /** Open a row as a page. */
  onOpenRow: (row: string) => void;
}) {
  const column = boardColumn(database, view);
  const [drag, setDrag] = useState<Drag | null>(null);
  const press = useRef<{ row: string; from: string; x: number; y: number; rect: DOMRect } | null>(null);
  const dragging = useRef<Drag | null>(null);

  const sortColumn = view.sort && database.columns.find((c) => c.id === view.sort?.column);
  const rows = useMemo(
    () => (sortColumn && view.sort ? sortRows(database.rows, sortColumn, view.sort.direction) : database.rows),
    [database.rows, sortColumn, view.sort],
  );
  const lanes = useMemo(() => (column ? toLanes(rows, column) : []), [rows, column]);
  const title = titleColumn(database.columns);

  // A stored groupBy that no longer fits (deleted or retyped column) is left
  // alone: the board shows the first column that fits until someone picks one.

  if (!column) return <NoGroupColumn actions={actions} onGroupBy={onGroupBy} />;

  const addCard = async (lane: Lane) => {
    const id = await actions.addRow();
    if (!id) return;
    if (lane.value !== null) actions.setCell(id, column.id, lane.value);
    onOpenRow(id);
  };

  const laneAt = (x: number, y: number) =>
    document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-lane]")?.dataset.lane ?? null;

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>, row: Row, lane: Lane) => {
    if (e.button !== 0) return;
    press.current = { row: row.id, from: lane.key, x: e.clientX, y: e.clientY, rect: e.currentTarget.getBoundingClientRect() };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p) return;
    if (!dragging.current && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_DISTANCE) return;
    const next: Drag = {
      row: p.row,
      from: p.from,
      x: e.clientX,
      y: e.clientY,
      dx: p.x - p.rect.left,
      dy: p.y - p.rect.top,
      width: p.rect.width,
      over: laneAt(e.clientX, e.clientY),
    };
    dragging.current = next;
    setDrag(next);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const p = press.current;
    const d = dragging.current;
    press.current = null;
    dragging.current = null;
    setDrag(null);
    if (!p) return;
    if (!d) {
      onOpenRow(p.row);
      return;
    }
    const target = lanes.find((l) => l.key === laneAt(e.clientX, e.clientY));
    if (target && target.key !== d.from) actions.setCell(d.row, column.id, target.value);
  };

  const onPointerCancel = () => {
    press.current = null;
    dragging.current = null;
    setDrag(null);
  };

  const dragged = drag && database.rows.find((r) => r.id === drag.row);

  return (
    <div className="board" data-dragging={drag ? "" : undefined}>
      {lanes.map((lane) => (
        <section
          key={lane.key}
          className={"board-lane" + (drag && drag.over === lane.key && drag.from !== lane.key ? " drop-target" : "")}
          data-lane={lane.key}
          aria-label={lane.label}
        >
          <header className="board-lane-header">
            {lane.tone ? (
              <span className={`db-pill tone-${lane.tone}`}>{lane.label}</span>
            ) : (
              <span className="board-lane-label">{lane.label}</span>
            )}
            <span className="board-count">{lane.rows.length}</span>
          </header>
          <div className="board-cards">
            {lane.rows.map((row) => (
              <Card
                key={row.id}
                row={row}
                columns={database.columns}
                title={title}
                group={column}
                dragging={drag?.row === row.id}
                onPointerDown={(e) => onPointerDown(e, row, lane)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
                onOpen={() => onOpenRow(row.id)}
              />
            ))}
          </div>
          <button className="board-new" onClick={() => void addCard(lane)}>
            <Plus size={14} aria-hidden /> New
          </button>
        </section>
      ))}
      {drag && dragged && (
        <div className="board-ghost" style={{ left: drag.x - drag.dx, top: drag.y - drag.dy, width: drag.width }} aria-hidden>
          <CardContent row={dragged} columns={database.columns} title={title} group={column} />
        </div>
      )}
    </div>
  );
}

function Card({
  row,
  columns,
  title,
  group,
  dragging,
  onOpen,
  ...pointer
}: {
  row: Row;
  columns: Column[];
  title: Column | null;
  group: Column;
  dragging: boolean;
  onOpen: () => void;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
}) {
  return (
    <div
      className={"board-card" + (dragging ? " dragging" : "")}
      role="button"
      tabIndex={0}
      aria-label={`${(title && cellText(row.cells[title.id])) || "Untitled"}: open`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      {...pointer}
    >
      <CardContent row={row} columns={columns} title={title} group={group} />
    </div>
  );
}

function CardContent({ row, columns, title, group }: { row: Row; columns: Column[]; title: Column | null; group: Column }) {
  const name = title ? cellText(row.cells[title.id]) : "";
  const fields = cardFields(row, columns, [title?.id, group.id]);
  return (
    <>
      <div className={"board-card-title" + (name ? "" : " untitled")}>{name || "Untitled"}</div>
      {fields.map(({ column, value }) => (
        <div key={column.id} className="board-card-field" title={column.name}>
          {column.type === "select" ? (
            <span className={`db-pill tone-${optionTone(cellText(value), column.options)}`}>{cellText(value)}</span>
          ) : column.type === "checkbox" && value === true ? (
            <>
              <Check size={13} aria-hidden /> {column.name}
            </>
          ) : (
            <>
              <span className="board-card-icon">{TYPE_ICONS[column.type](12)}</span>
              <span className="board-card-value">{fieldText(column, value)}</span>
            </>
          )}
        </div>
      ))}
    </>
  );
}

/** A board needs a column to group by; offer to add one. */
function NoGroupColumn({ actions, onGroupBy }: { actions: DatabaseActions; onGroupBy: (column: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="board-empty">
      <Columns3 size={22} aria-hidden />
      <p>A board shows rows as cards, in a lane for each choice of a select column. This database has none yet.</p>
      <button
        className="button primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const id = await actions.addColumn("Status", "select", { options: ["Not started", "In progress", "Done"] });
          setBusy(false);
          if (id) onGroupBy(id);
        }}
      >
        <Plus size={14} aria-hidden /> Add a Status column
      </button>
    </div>
  );
}
