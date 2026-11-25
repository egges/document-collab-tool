// The developer panel's Databases section: every database in the open
// workspace, and the chosen one as a table to view and edit. Create, rename
// and delete databases here; columns and rows in the table. Editing is in
// useDatabase.ts, shared with database pages.
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Database as DatabaseIcon, Plus, Trash2, X } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { type Database, type DatabaseSummary, dbApi, errorText, events } from "./api.ts";
import { log } from "./devlog.ts";
import { TableView } from "./TableView.tsx";
import { useDatabase } from "./useDatabase.ts";

export function DatabasesPanel() {
  const [list, setList] = useState<DatabaseSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setErrorState] = useState<string | null>(null);
  const [focusName, setFocusName] = useState(false);
  const lists = useRef(0);

  const setError = useCallback((message: string | null) => {
    if (message) log("error", "ui", `Shown in the Databases panel: ${message}`);
    setErrorState(message);
  }, []);

  const refreshList = useCallback(async () => {
    const read = ++lists.current;
    try {
      const all = await dbApi.list();
      if (read !== lists.current) return;
      setList(all);
      // Nothing chosen, or the chosen one is gone (deleted here or by a sync): the first.
      setSelected((id) => (id && all.some((d) => d.id === id) ? id : (all[0]?.id ?? null)));
    } catch (e) {
      if (read === lists.current) setError(errorText(e));
    }
  }, [setError]);

  const { db, edit, actions } = useDatabase(selected, { onError: setError, onSaved: () => void refreshList() });

  useEffect(() => {
    void refreshList();
    const unlisten = events.onWorkspaceChanged(() => void refreshList());
    return () => void unlisten.then((f) => f());
  }, [refreshList]);

  const create = async () => {
    try {
      const id = await dbApi.create("Untitled database");
      setFocusName(true);
      setSelected(id);
      await refreshList();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const remove = async (target: Database) => {
    const sure = await ask(
      `Delete “${target.name || "Untitled"}” with its ${target.rows.length} rows? It's deleted on every device that syncs this workspace.`,
      { title: "Delete database", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" },
    );
    if (!sure) return;
    await edit(null, () => dbApi.remove(target.id));
  };

  return (
    <div className="db-panel">
      <nav className="db-list" aria-label="Databases">
        <div className="db-list-header">
          <span>Databases</span>
          <button className="icon-button" title="New database" aria-label="New database" onClick={() => void create()}>
            <Plus size={15} />
          </button>
        </div>
        {list?.map((d) => (
          <button
            key={d.id}
            className={"db-list-item" + (d.id === selected ? " selected" : "")}
            aria-current={d.id === selected}
            onClick={() => setSelected(d.id)}
          >
            <DatabaseIcon size={13} aria-hidden />
            <span className="db-list-name">{d.name || "Untitled"}</span>
            <span className="db-list-count">{d.rows}</span>
          </button>
        ))}
        {list?.length === 0 && <p className="muted db-list-empty">No databases in this workspace yet.</p>}
      </nav>
      <section className="db-main">
        {error && (
          <div className="banner banner-error db-error" role="alert">
            <span>{error}</span>
            <button className="icon-button" aria-label="Dismiss" title="Dismiss" onClick={() => setError(null)}>
              <X size={14} />
            </button>
          </div>
        )}
        {db && actions ? (
          <>
            <header className="db-header-bar">
              <DatabaseName
                key={db.id}
                name={db.name}
                autoFocus={focusName}
                onRename={(name) => {
                  setFocusName(false);
                  void edit((d) => ({ ...d, name }), () => dbApi.rename(db.id, name));
                }}
              />
              <span className="db-facts muted">
                {db.rows.length} {db.rows.length === 1 ? "row" : "rows"} · {db.columns.length}{" "}
                {db.columns.length === 1 ? "column" : "columns"} · <CopyText label="id" text={db.id} /> ·{" "}
                <CopyText label="folder" text={db.path} />
              </span>
              <button
                className="icon-button danger"
                title="Delete this database"
                aria-label="Delete database"
                onClick={() => void remove(db)}
              >
                <Trash2 size={15} />
              </button>
            </header>
            <div className="db-scroll">
              <TableView database={db} actions={actions} />
            </div>
          </>
        ) : (
          list && (
            <div className="db-empty">
              <p className="muted">
                {list.length ? "Choose a database." : "Databases are tables of rows, one file per row, that sync like pages."}
              </p>
              {!list.length && (
                <button className="button" onClick={() => void create()}>
                  <Plus size={14} aria-hidden /> New database
                </button>
              )}
            </div>
          )
        )}
      </section>
    </div>
  );
}

function DatabaseName({
  name,
  autoFocus,
  onRename,
}: {
  name: string;
  autoFocus: boolean;
  onRename: (name: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const commit = () => {
    const trimmed = draft?.trim();
    setDraft(null);
    if (cancelled.current) cancelled.current = false;
    else if (trimmed && trimmed !== name) onRename(trimmed);
  };
  return (
    <input
      className="db-name"
      aria-label="Database name"
      value={draft ?? name}
      placeholder="Untitled"
      autoFocus={autoFocus}
      onFocus={(e) => {
        setDraft(name);
        e.currentTarget.select();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          e.stopPropagation();
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
      spellCheck={false}
    />
  );
}

/** "id" that copies the database's id when clicked, for bug reports and agents. */
function CopyText({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="link db-copy"
      title={`${text}\nClick to copy`}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {label} {copied ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
    </button>
  );
}
