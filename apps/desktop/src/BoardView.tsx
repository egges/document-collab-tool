// A database as a board: a lane per choice of a select column (or checked
// and not, for a checkbox column), a card per row. Drag a card to another
// lane to change its value, and up or down to put it where you want it;
// click it to open the row as a page. Which column the board groups by is
// kept on the page's view (DatabasePageView.tsx), and the cards' order is
// the view's own too, kept on each row (boards.ts). A sorted board keeps
// its sort's order: dragging a card to another place in its lane offers to
// remove the sort.
//
// Like TableView, it edits nothing itself: every change goes to `actions`.
import { ask } from "@tauri-apps/plugin-dialog";
import { type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Check, Columns3, Plus } from "lucide-react";
import type { Column, Database, Row, View } from "./api.ts";
import {
  type Lane,
  boardColumn,
  cardFields,
  dropPositions,
  fieldText,
  lanes as toLanes,
  titleColumn,
  viewOrder,
} from "./boards.ts";
import { TYPE_ICONS } from "./DatabaseCell.tsx";
import { cellText, optionTone, sortRows } from "./databases.ts";
import type { DatabaseActions } from "./useDatabase.ts";

/** A card being dragged: where it came from, where the pointer is, and where it would land. */
interface Drag {
  row: string;
  from: string;
  /** The pointer, and where on the card it grabbed it. */
  x: number;
  y: number;
  dx: number;
  dy: number;
  width: number;
  /** The lane under the pointer. */
  over: string | null;
  /** Where in that lane: before which of its other cards (their number: after the last). */
  index: number;
}

/** How far the pointer moves before a press on a card becomes a drag. */
const DRAG_DISTANCE = 4;

/** How far left or right of a lane, or above the board, the pointer still counts as over it. */
const LANE_REACH = 12;

/** Within this distance of an edge of what scrolls, a drag scrolls it. */
const SCROLL_EDGE = 48;

/** The nearest element around `from` that scrolls along `axis`. */
function scrollParent(from: HTMLElement, axis: "x" | "y"): HTMLElement | null {
  for (let el = from.parentElement; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    const overflow = axis === "x" ? style.overflowX : style.overflowY;
    const room = axis === "x" ? el.scrollWidth > el.clientWidth : el.scrollHeight > el.clientHeight;
    if (room && (overflow === "auto" || overflow === "scroll")) return el;
  }
  return null;
}

/** Scroll what's around the board while the pointer is near its edge. True when something moved. */
function scrollNearEdge(scrollers: { x: HTMLElement | null; y: HTMLElement | null }, x: number, y: number): boolean {
  let moved = false;
  for (const axis of ["x", "y"] as const) {
    const el = scrollers[axis];
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    const at = axis === "x" ? x : y;
    const start = axis === "x" ? Math.max(rect.left, 0) : Math.max(rect.top, 0);
    const end = axis === "x" ? Math.min(rect.right, window.innerWidth) : Math.min(rect.bottom, window.innerHeight);
    // Faster the closer to the edge, and past it.
    const past = Math.max(start + SCROLL_EDGE - at, at - (end - SCROLL_EDGE));
    if (past <= 0) continue;
    const by = Math.min(20, Math.ceil(past / 3)) * (at < start + SCROLL_EDGE ? -1 : 1);
    const prop = axis === "x" ? "scrollLeft" : "scrollTop";
    const before = el[prop];
    el[prop] += by;
    if (el[prop] !== before) moved = true;
  }
  return moved;
}

export function BoardView({
  database,
  view,
  actions,
  onGroupBy,
  onSort,
  onOpenRow,
}: {
  database: Database;
  view: View;
  actions: DatabaseActions;
  onGroupBy: (column: string) => void;
  /** Change the view's sort; null removes it, leaving the cards in their own order. */
  onSort: (sort: View["sort"]) => void;
  /** Open a row as a page. */
  onOpenRow: (row: string) => void;
}) {
  const column = boardColumn(database, view);
  const [drag, setDrag] = useState<Drag | null>(null);
  const press = useRef<{ row: string; from: string; x: number; y: number; rect: DOMRect } | null>(null);
  const dragging = useRef<Drag | null>(null);
  const board = useRef<HTMLDivElement>(null);
  const scrollers = useRef<{ x: HTMLElement | null; y: HTMLElement | null }>({ x: null, y: null });

  // Sorted, the sort's order; else the view's own, which dragging changes.
  const sortColumn = (view.sort && database.columns.find((c) => c.id === view.sort?.column)) || null;
  const rows = useMemo(
    () =>
      sortColumn && view.sort
        ? sortRows(database.rows, sortColumn, view.sort.direction)
        : viewOrder(database.rows, view.id),
    [database.rows, sortColumn, view.sort, view.id],
  );
  const lanes = useMemo(() => (column ? toLanes(rows, column) : []), [rows, column]);
  const title = titleColumn(database.columns);

  const stopDrag = () => {
    press.current = null;
    dragging.current = null;
    setDrag(null);
  };

  /** The lane under the pointer, and where among its other cards `row` would land. */
  const dropAt = (x: number, y: number, row: string): { lane: string; index: number } | null => {
    const el = board.current;
    if (!el || y < el.getBoundingClientRect().top - LANE_REACH) return null;
    // Not a lane scrolled out of sight, under the sidebar.
    const clip = scrollers.current.x?.getBoundingClientRect();
    if (clip && (x < clip.left || x > clip.right)) return null;
    // Anywhere under a lane counts: lanes are as tall as their cards.
    for (const lane of el.querySelectorAll<HTMLElement>("[data-lane]")) {
      const rect = lane.getBoundingClientRect();
      if (x < rect.left - LANE_REACH || x > rect.right + LANE_REACH) continue;
      let index = 0;
      for (const card of lane.querySelectorAll<HTMLElement>("[data-card]")) {
        if (card.dataset.card === row) continue;
        const c = card.getBoundingClientRect();
        if (y > c.top + c.height / 2) index++;
      }
      return { lane: lane.dataset.lane ?? "", index };
    }
    return null;
  };

  /** The drag with the pointer at (x, y). */
  const dragTo = (d: Omit<Drag, "x" | "y" | "over" | "index">, x: number, y: number) => {
    const drop = dropAt(x, y, d.row);
    const next: Drag = { ...d, x, y, over: drop?.lane ?? null, index: drop?.index ?? 0 };
    dragging.current = next;
    setDrag(next);
  };

  // While dragging: scroll when the pointer is near an edge (the board
  // sideways, the page up and down), and Esc puts the card back.
  const active = drag !== null;
  useEffect(() => {
    if (!active) return;
    let frame = requestAnimationFrame(function step() {
      const d = dragging.current;
      if (d && scrollNearEdge(scrollers.current, d.x, d.y)) dragTo(d, d.x, d.y);
      frame = requestAnimationFrame(step);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      stopDrag();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [active]);

  // A stored groupBy that no longer fits (deleted or retyped column) is left
  // alone: the board shows the first column that fits until someone picks one.

  if (!column) return <NoGroupColumn actions={actions} onGroupBy={onGroupBy} />;

  const addCard = async (lane: Lane) => {
    const id = await actions.addRow();
    if (!id) return;
    if (lane.value !== null) actions.setCell(id, column.id, lane.value);
    onOpenRow(id);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>, row: Row, lane: Lane) => {
    if (e.button !== 0) return;
    press.current = { row: row.id, from: lane.key, x: e.clientX, y: e.clientY, rect: e.currentTarget.getBoundingClientRect() };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p) return;
    if (!dragging.current) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_DISTANCE) return;
      scrollers.current = board.current
        ? { x: scrollParent(board.current, "x"), y: scrollParent(board.current, "y") }
        : { x: null, y: null };
    }
    const grabbed = { row: p.row, from: p.from, dx: p.x - p.rect.left, dy: p.y - p.rect.top, width: p.rect.width };
    dragTo(grabbed, e.clientX, e.clientY);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const p = press.current;
    const d = dragging.current;
    stopDrag();
    if (!p) return;
    if (!d) {
      onOpenRow(p.row);
      return;
    }
    const drop = dropAt(e.clientX, e.clientY, d.row);
    if (drop) void dropCard(d.row, drop.lane, drop.index);
  };

  /** Where `row` is among a lane's cards, and the lane's other cards. */
  const placeIn = (lane: Lane, row: string) => ({
    at: lane.rows.findIndex((r) => r.id === row),
    others: lane.rows.filter((r) => r.id !== row),
  });

  /** Drop a card in a lane, before the card at `index` of that lane's other cards. */
  const dropCard = async (id: string, laneKey: string, index: number) => {
    const row = database.rows.find((r) => r.id === id);
    const target = lanes.find((l) => l.key === laneKey);
    if (!row || !target) return;
    const { at, others } = placeIn(target, id);
    const cell = at < 0 ? { column: column.id, value: target.value } : null;
    if (!sortColumn) {
      if (at === index) return;
      actions.moveRow(id, cell, view.id, dropPositions(others, index, row, view.id));
      return;
    }
    // Sorted: the sort decides where a card sits in its lane.
    if (cell) {
      actions.setCell(id, cell.column, cell.value);
      return;
    }
    if (at === index) return;
    const removeSort = await ask(`This board is sorted by “${sortColumn.name}”. Remove the sort to arrange cards by hand?`, {
      title: "Sorted board",
      kind: "info",
      okLabel: "Remove sort",
      cancelLabel: "Cancel",
    });
    if (!removeSort) return;
    onSort(null);
    // Without the sort the lane is in its own order again: the card goes
    // next to the one it was dropped under (or above, at the top).
    const own = toLanes(viewOrder(database.rows, view.id), column).find((l) => l.key === laneKey);
    if (!own) return;
    const ownOthers = own.rows.filter((r) => r.id !== id);
    const under = others[index - 1];
    const anchor = ownOthers.findIndex((r) => r.id === (under ?? others[index])?.id);
    const positions = dropPositions(ownOthers, under ? anchor + 1 : Math.max(anchor, 0), row, view.id);
    if (Object.keys(positions).length > 0) actions.moveRow(id, null, view.id, positions);
  };

  /** Where the line that shows a drop goes in a lane: before which of its other cards. */
  const dropLine = (lane: Lane): number | null => {
    if (!drag || drag.over !== lane.key) return null;
    const { at, others } = placeIn(lane, drag.row);
    // Not where the card already is, where the sort decides, or in an empty lane (it lights up).
    if (at === drag.index || (sortColumn && at < 0) || others.length === 0) return null;
    return drag.index;
  };

  const dragged = drag && database.rows.find((r) => r.id === drag.row);

  return (
    <div className="board" ref={board} data-dragging={drag ? "" : undefined}>
      {lanes.map((lane) => {
        const line = dropLine(lane);
        const cards: ReactNode[] = [];
        let others = 0;
        for (const row of lane.rows) {
          const self = drag?.row === row.id;
          if (!self && others++ === line) cards.push(<div key="drop-line" className="board-drop" aria-hidden />);
          cards.push(
            <Card
              key={row.id}
              row={row}
              columns={database.columns}
              title={title}
              group={column}
              dragging={self}
              onPointerDown={(e) => onPointerDown(e, row, lane)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={stopDrag}
              onOpen={() => onOpenRow(row.id)}
            />,
          );
        }
        if (others === line) cards.push(<div key="drop-line" className="board-drop" aria-hidden />);
        return (
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
            <div className="board-cards">{cards}</div>
            <button className="board-new" onClick={() => void addCard(lane)}>
              <Plus size={14} aria-hidden /> New
            </button>
          </section>
        );
      })}
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
      data-card={row.id}
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
