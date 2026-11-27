// A database page: a title, the page's views as tabs (each a table or a
// board), and the chosen view. Views, with their sort and grouping, are kept
// in the page's meta.json, so everyone sees the same; which tab is open is
// this device's own. A page without a database (yet, or any more) asks
// which to show. The format is in docsync::database_page.
import { ask } from "@tauri-apps/plugin-dialog";
import { type ReactNode, type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Columns3, Database as DatabaseIcon, Plus, Sheet, Trash2 } from "lucide-react";
import {
  type DatabasePageInfo,
  type DatabaseSummary,
  type Page,
  type PageDisplay,
  type View,
  type ViewType,
  api,
  dbApi,
  errorText,
} from "./api.ts";
import { BoardView } from "./BoardView.tsx";
import { groupableColumns, newViewName, nextViewPosition } from "./boards.ts";
import { log } from "./devlog.ts";
import { insideText, pagesInside } from "./pageTree.ts";
import type { PageViewHandle } from "./PageView.tsx";
import { Popover } from "./Popover.tsx";
import { TableView } from "./TableView.tsx";
import { useDatabase } from "./useDatabase.ts";

const VIEW_TYPES: { type: ViewType; label: string; icon: (size: number) => ReactNode }[] = [
  { type: "table", label: "Table", icon: (s) => <Sheet size={s} aria-hidden /> },
  { type: "board", label: "Board", icon: (s) => <Columns3 size={s} aria-hidden /> },
];

const viewIcon = (type: ViewType, size: number) => VIEW_TYPES.find((t) => t.type === type)!.icon(size);

/** The tab open on this device, per page. */
const ACTIVE_VIEW_KEY = (page: string) => `sawmill.view.${page}`;

function readActiveView(page: string): string | null {
  try {
    return localStorage.getItem(ACTIVE_VIEW_KEY(page));
  } catch {
    return null;
  }
}

function keepActiveView(page: string, view: string) {
  try {
    localStorage.setItem(ACTIVE_VIEW_KEY(page), view);
  } catch {
    // Not kept: the first tab opens next time.
  }
}

/** A random id like the Rust side's: 12 characters from [0-9a-z]. */
function newId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => alphabet[b % 36]).join("");
}

export function DatabasePageView({
  id,
  initial,
  diskVersion,
  onRenamed,
  onTitleChange,
  display,
  onDisplay,
  onDeleted,
  onError,
  onOpenPage,
  ref,
}: {
  id: string;
  initial: Page & { database: DatabasePageInfo };
  diskVersion: number;
  onRenamed: () => void;
  onTitleChange?: (title: string) => void;
  display: PageDisplay | null;
  onDisplay: (display: PageDisplay) => void;
  onDeleted: () => void;
  onError: (message: string) => void;
  /** Open a row as a page. */
  onOpenPage: (id: string) => void;
  ref?: Ref<PageViewHandle>;
}) {
  const [info, setInfo] = useState(initial.database);
  const [title, setTitle] = useState(initial.title);
  const titleSaved = useRef(initial.title);
  const titleInput = useRef<HTMLInputElement>(null);
  const shown = info.id && info.exists ? info.id : null;
  // Rows are in the page list (for the breadcrumb and search): reread it after edits.
  const { db, problem, actions } = useDatabase(shown, { onError, onSaved: onRenamed });
  const [activeId, setActiveId] = useState(() => readActiveView(id));
  const view = info.views.find((v) => v.id === activeId) ?? info.views[0];

  const reread = useCallback(async () => {
    try {
      const page = await api.readPage(id);
      if (page.database) setInfo(page.database);
      onDisplay(page.display);
      if (document.activeElement !== titleInput.current && page.title !== titleSaved.current) {
        titleSaved.current = page.title;
        setTitle(page.title);
        onTitleChange?.(page.title);
      }
    } catch {
      // Deleted: the page list update closes this view.
    }
  }, [id, onDisplay, onTitleChange]);

  useEffect(() => {
    log("info", "ui", `Opened database page ${id} (database ${initial.database.id ?? "not chosen"})`);
    onDisplay(initial.display);
    // A new page starts with its title focused.
    if (!initial.title) titleInput.current?.focus();
  }, [id, initial]);

  // Files changed on disk: reread the page (its views, its database).
  const firstDiskVersion = useRef(diskVersion);
  useEffect(() => {
    if (diskVersion !== firstDiskVersion.current) void reread();
  }, [diskVersion, reread]);

  const saveTitle = async () => {
    const next = titleInput.current?.value ?? title;
    const before = titleSaved.current;
    if (next === before) return;
    titleSaved.current = next;
    try {
      await api.renamePage(id, next);
      onRenamed();
      // The database was named after the page: it follows the page's name.
      if (db && next.trim() && (db.name === before.trim() || (!before.trim() && db.name === "Untitled"))) {
        await dbApi.rename(db.id, next.trim());
      }
    } catch (e) {
      onError(errorText(e));
    }
  };

  const remove = async () => {
    const pages = await api.listPages();
    const going = new Set([id, ...pagesInside(pages, id)]);
    // Pages that keep showing the database once this one and those inside it are gone.
    const others = info.id ? pages.filter((p) => !going.has(p.id) && p.database === info.id) : [];
    const name = title || "Untitled";
    const inside = insideText(going.size - 1);
    const takesDatabase = db && others.length === 0;
    const confirmed = await ask(
      takesDatabase
        ? `Delete “${name}”${inside} with its database of ${db.rows.length} ${db.rows.length === 1 ? "row" : "rows"}?`
        : `Delete “${name}”${inside}? Its database stays, shown on ${others.length === 1 ? "another page" : "other pages"}.`,
      { title: "Delete page", kind: "warning", okLabel: "Delete" },
    );
    if (!confirmed) return;
    try {
      await api.deletePage(id);
      onDeleted();
    } catch (e) {
      onError(errorText(e));
    }
  };

  useImperativeHandle(ref, () => ({ flush: saveTitle, remove }));

  const activate = (viewId: string) => {
    setActiveId(viewId);
    keepActiveView(id, viewId);
  };

  /** Show the change at once, then save it; on failure, show what's on disk again. */
  const saveView = (next: View | null, viewId: string) => {
    setInfo((i) => ({
      ...i,
      views: next
        ? i.views.some((v) => v.id === viewId)
          ? i.views.map((v) => (v.id === viewId ? next : v))
          : [...i.views, next]
        : i.views.filter((v) => v.id !== viewId),
    }));
    api.setPageView(id, viewId, next).catch((e) => {
      onError(errorText(e));
      void reread();
    });
  };

  const addView = (type: ViewType) => {
    const label = VIEW_TYPES.find((t) => t.type === type)!.label;
    const next: View = {
      id: newId(),
      name: newViewName(info.views, label),
      type,
      position: nextViewPosition(info.views),
      sort: null,
      groupBy: null,
    };
    saveView(next, next.id);
    activate(next.id);
  };

  const choose = async (database: string | null) => {
    try {
      const target = database ?? (await dbApi.create(title.trim() || "Untitled"));
      await api.setPageDatabase(id, target);
      await reread();
    } catch (e) {
      onError(errorText(e));
    }
  };

  const shownDisplay = display ?? initial.display;
  return (
    <article
      className="page database-page"
      data-width={shownDisplay.width ?? undefined}
      data-text-size={shownDisplay.textSize ?? undefined}
    >
      <header className="page-header">
        <input
          ref={titleInput}
          className="page-title"
          placeholder="Untitled"
          value={title}
          aria-label="Page title"
          onChange={(e) => {
            setTitle(e.target.value);
            onTitleChange?.(e.target.value);
          }}
          onBlur={() => void saveTitle()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
      </header>
      {!shown || problem ? (
        <DatabasePicker missing={!!info.id} onChoose={(database) => void choose(database)} onError={onError} />
      ) : (
        <>
          <ViewTabs
            views={info.views}
            active={view}
            groupable={db ? groupableColumns(db.columns).map((c) => ({ id: c.id, name: c.name })) : []}
            rows={db?.rows.length ?? null}
            onActivate={activate}
            onChange={(next) => saveView(next, next.id)}
            onRemove={(v) => {
              saveView(null, v.id);
              if (v.id === view.id) activate(info.views.find((o) => o.id !== v.id)!.id);
            }}
            onAdd={addView}
          />
          {db && actions && (
            <div className={"database-view" + (view.type === "board" ? " is-board" : "")}>
              {view.type === "board" ? (
                <BoardView
                  database={db}
                  view={view}
                  actions={actions}
                  onGroupBy={(groupBy) => saveView({ ...view, groupBy }, view.id)}
                  onOpenRow={onOpenPage}
                />
              ) : (
                <TableView
                  database={db}
                  actions={actions}
                  sort={view.sort}
                  onSort={(sort) => saveView({ ...view, sort }, view.id)}
                  onOpenRow={onOpenPage}
                />
              )}
            </div>
          )}
        </>
      )}
    </article>
  );
}

/** Choose what a page shows: a new database, or one already in the workspace. */
function DatabasePicker({
  missing,
  onChoose,
  onError,
}: {
  /** The page had a database, deleted since. */
  missing: boolean;
  /** null: a new database. */
  onChoose: (database: string | null) => void;
  onError: (message: string) => void;
}) {
  const [list, setList] = useState<DatabaseSummary[] | null>(null);
  useEffect(() => {
    dbApi
      .list()
      .then(setList)
      .catch((e) => onError(errorText(e)));
  }, [onError]);
  return (
    <div className="db-picker">
      {missing && <p className="db-picker-note">This page's database was deleted, on this device or another.</p>}
      <button className="button primary" onClick={() => onChoose(null)} autoFocus>
        <Plus size={14} aria-hidden /> New database
      </button>
      {list && list.length > 0 && (
        <>
          <p className="muted">Or show a database that's already in this workspace:</p>
          <div className="db-picker-list">
            {list.map((d) => (
              <button key={d.id} className="db-list-item" onClick={() => onChoose(d.id)}>
                <DatabaseIcon size={13} aria-hidden />
                <span className="db-list-name">{d.name || "Untitled"}</span>
                <span className="db-list-count">
                  {d.rows} {d.rows === 1 ? "row" : "rows"}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ViewTabs({
  views,
  active,
  groupable,
  rows,
  onActivate,
  onChange,
  onRemove,
  onAdd,
}: {
  views: View[];
  active: View;
  /** Columns a board can group by. */
  groupable: { id: string; name: string }[];
  rows: number | null;
  onActivate: (id: string) => void;
  onChange: (view: View) => void;
  onRemove: (view: View) => void;
  onAdd: (type: ViewType) => void;
}) {
  const [menu, setMenu] = useState<string | null>(null);
  return (
    <div className="view-tabs">
      <div className="view-tab-list" role="tablist" aria-label="Views">
        {views.map((v) => (
          <ViewTab
            key={v.id}
            view={v}
            selected={v.id === active.id}
            open={menu === v.id}
            groupable={groupable}
            canRemove={views.length > 1}
            onOpen={(open) => setMenu(open ? v.id : null)}
            onActivate={() => onActivate(v.id)}
            onChange={onChange}
            onRemove={() => onRemove(v)}
          />
        ))}
        <Popover
          label="Add a view"
          trigger={(toggle, expanded) => (
            <button
              className="icon-button"
              title="Add a view"
              aria-label="Add a view"
              aria-haspopup="menu"
              aria-expanded={expanded}
              onClick={toggle}
            >
              <Plus size={15} />
            </button>
          )}
        >
          {(close) =>
            VIEW_TYPES.map((t) => (
              <button
                key={t.type}
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  close();
                  onAdd(t.type);
                }}
              >
                <span className="menu-check">{t.icon(14)}</span>
                <span className="menu-label">{t.label}</span>
              </button>
            ))
          }
        </Popover>
      </div>
      {rows !== null && (
        <span className="view-count muted">
          {rows} {rows === 1 ? "row" : "rows"}
        </span>
      )}
    </div>
  );
}

function ViewTab({
  view,
  selected,
  open,
  groupable,
  canRemove,
  onOpen,
  onActivate,
  onChange,
  onRemove,
}: {
  view: View;
  selected: boolean;
  open: boolean;
  groupable: { id: string; name: string }[];
  canRemove: boolean;
  onOpen: (open: boolean) => void;
  onActivate: () => void;
  onChange: (view: View) => void;
  onRemove: () => void;
}) {
  const close = useCallback(() => onOpen(false), [onOpen]);
  const groupBy = groupable.find((c) => c.id === view.groupBy) ?? groupable[0];
  return (
    <Popover
      label={`View ${view.name}`}
      open={open}
      onOpenChange={onOpen}
      trigger={(toggle, expanded) => (
        <button
          role="tab"
          aria-selected={selected}
          aria-haspopup="menu"
          aria-expanded={expanded}
          className={"view-tab" + (selected ? " selected" : "")}
          title={selected ? "Click for this view's settings" : undefined}
          // The open tab's settings are a click away, as in Notion.
          onClick={() => (selected ? toggle() : onActivate())}
        >
          {viewIcon(view.type, 14)}
          <span>{view.name}</span>
        </button>
      )}
    >
      {() => (
        <>
          <ViewName name={view.name} onRename={(name) => onChange({ ...view, name })} onDone={close} />
          <div className="db-menu-title">Layout</div>
          {VIEW_TYPES.map((t) => (
            <button
              key={t.type}
              role="menuitemradio"
              aria-checked={view.type === t.type}
              className={"menu-item" + (view.type === t.type ? " selected" : "")}
              onClick={() => view.type !== t.type && onChange({ ...view, type: t.type })}
            >
              <span className="menu-check">{t.icon(14)}</span>
              <span className="menu-label">{t.label}</span>
            </button>
          ))}
          {view.type === "board" && groupable.length > 0 && (
            <>
              <div className="db-menu-title">Group by</div>
              {groupable.map((c) => (
                <button
                  key={c.id}
                  role="menuitemradio"
                  aria-checked={groupBy?.id === c.id}
                  className={"menu-item" + (groupBy?.id === c.id ? " selected" : "")}
                  onClick={() => onChange({ ...view, groupBy: c.id })}
                >
                  <span className="menu-check" />
                  <span className="menu-label">{c.name}</span>
                </button>
              ))}
            </>
          )}
          <div className="menu-separator" role="separator" />
          <button
            role="menuitem"
            className="menu-item danger"
            disabled={!canRemove}
            title={canRemove ? undefined : "A page keeps at least one view"}
            onClick={() => {
              close();
              onRemove();
            }}
          >
            <span className="menu-check">
              <Trash2 size={14} />
            </span>
            <span className="menu-label">Delete view</span>
          </button>
        </>
      )}
    </Popover>
  );
}

/** The view's name, renamed on Enter or when focus leaves it. */
function ViewName({ name, onRename, onDone }: { name: string; onRename: (name: string) => void; onDone: () => void }) {
  const [draft, setDraft] = useState(name);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) onRename(trimmed);
    else setDraft(name);
  };
  return (
    <input
      className="input db-column-name"
      aria-label="View name"
      value={draft}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
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
