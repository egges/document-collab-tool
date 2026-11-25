// One database, read and edited from the window: by the developer panel's
// Databases tab and by database pages.
//
// Edits show at once and are saved in the background; after each one the
// database is read again, so what's shown is what's on disk. Changes from a
// sync or another program show up the same way.
import { useCallback, useEffect, useRef, useState } from "react";
import { type CellValue, type ColumnChange, type ColumnType, type Database, dbApi, errorText, events } from "./api.ts";
import { newColumnName } from "./databases.ts";

export interface DatabaseActions {
  setCell: (row: string, column: string, value: CellValue | null) => void;
  /** Resolves to the new row's id. */
  addRow: () => Promise<string | null>;
  deleteRow: (row: string) => void;
  /** Resolves to the new column's id. */
  addColumn: (name?: string, type?: ColumnType, change?: ColumnChange) => Promise<string | null>;
  updateColumn: (column: string, change: ColumnChange) => void;
  deleteColumn: (column: string) => void;
  onError: (message: string) => void;
}

export function useDatabase(
  id: string | null,
  {
    onError,
    onSaved,
  }: {
    onError: (message: string) => void;
    /** After every edit has been saved (or failed) and read back. */
    onSaved?: () => void;
  },
) {
  const [db, setDb] = useState<Database | null>(null);
  // Why it couldn't be read (deleted, most likely); null when it could.
  const [problem, setProblem] = useState<string | null>(null);
  // Only the latest read may replace what's shown: an older one finishing
  // late would undo an edit made since.
  const reads = useRef(0);
  const idRef = useRef(id);
  idRef.current = id;

  const refresh = useCallback(async () => {
    const read = ++reads.current;
    const current = idRef.current;
    if (!current) {
      setDb(null);
      setProblem(null);
      return;
    }
    try {
      const fresh = await dbApi.read(current);
      if (read !== reads.current) return;
      setDb(fresh);
      setProblem(null);
    } catch (e) {
      if (read !== reads.current) return;
      setDb(null);
      setProblem(errorText(e));
    }
  }, []);

  useEffect(() => {
    setDb((d) => (d?.id === id ? d : null));
    void refresh();
  }, [id, refresh]);

  useEffect(() => {
    const unlisten = events.onWorkspaceChanged(() => void refresh());
    return () => void unlisten.then((f) => f());
  }, [refresh]);

  /** Show `local` at once, save with `save`, then read back what's on disk. */
  const edit = async <T,>(local: ((d: Database) => Database) | null, save: () => Promise<T>): Promise<T | null> => {
    if (local) setDb((d) => d && local(d));
    try {
      return await save();
    } catch (e) {
      onError(errorText(e));
      return null;
    } finally {
      await refresh();
      onSaved?.();
    }
  };

  const actions: DatabaseActions | null = db && {
    setCell: (row, column, value) =>
      void edit(
        (d) => ({
          ...d,
          rows: d.rows.map((r) => {
            if (r.id !== row) return r;
            const cells = { ...r.cells };
            if (value === null) delete cells[column];
            else cells[column] = value;
            return { ...r, cells };
          }),
        }),
        () => dbApi.setCell(db.id, row, column, value),
      ),
    addRow: () => edit(null, () => dbApi.addRow(db.id)),
    deleteRow: (row) =>
      void edit(
        (d) => ({ ...d, rows: d.rows.filter((r) => r.id !== row) }),
        () => dbApi.deleteRow(db.id, row),
      ),
    addColumn: (name = newColumnName(db.columns), type = "text", change) =>
      edit(null, async () => {
        const column = await dbApi.addColumn(db.id, name, type);
        if (change) await dbApi.updateColumn(db.id, column, change);
        return column;
      }),
    updateColumn: (column, change) =>
      void edit(
        (d) => ({ ...d, columns: d.columns.map((c) => (c.id === column ? { ...c, ...change } : c)) }),
        () => dbApi.updateColumn(db.id, column, change),
      ),
    deleteColumn: (column) =>
      void edit(
        (d) => ({ ...d, columns: d.columns.filter((c) => c.id !== column) }),
        () => dbApi.deleteColumn(db.id, column),
      ),
    onError,
  };

  return { db, problem, refresh, edit, actions };
}
