// Typed wrappers for the Rust commands in src-tauri/src/commands.rs.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface WorkspaceInfo {
  path: string;
  name: string;
  /** This device's name, as it appears in conflict blocks. */
  device: string;
  remote: string | null;
}

export interface PageSummary {
  id: string;
  title: string;
  /** Never points at a missing page: orphans come back as top-level pages. */
  parent: string | null;
}

export interface ConflictVersion {
  label: string;
  text: string;
}

export interface Conflict {
  versions: ConflictVersion[];
}

export interface Page {
  id: string;
  title: string;
  body: string;
  conflicts: Conflict[];
}

export type WriteResult =
  | { status: "written"; conflicts: Conflict[] }
  | { status: "merged"; page: Page }
  | { status: "gone" };

export type SyncState = "localOnly" | "syncing" | "synced" | "offline" | "error";

export interface SyncStatus {
  state: SyncState;
  message: string | null;
  /** Milliseconds since the Unix epoch. */
  lastSynced: number | null;
  /** Conflicts the last sync kept both versions of. */
  conflicts: number;
}

export const api = {
  restoreWorkspace: () => invoke<WorkspaceInfo | null>("restore_workspace"),
  openWorkspace: (path: string) => invoke<WorkspaceInfo>("open_workspace", { path }),
  cloneWorkspace: (url: string, path: string) => invoke<WorkspaceInfo>("clone_workspace", { url, path }),
  closeWorkspace: () => invoke<void>("close_workspace"),
  setRemote: (url: string | null) => invoke<WorkspaceInfo>("set_remote", { url }),
  syncStatus: () => invoke<SyncStatus | null>("sync_status"),
  syncNow: () => invoke<void>("sync_now"),
  listPages: () => invoke<PageSummary[]>("list_pages"),
  readPage: (id: string) => invoke<Page>("read_page", { id }),
  writePage: (id: string, base: string, body: string) => invoke<WriteResult>("write_page", { id, base, body }),
  createPage: (title: string, parent: string | null) => invoke<string>("create_page", { title, parent }),
  renamePage: (id: string, title: string) => invoke<void>("rename_page", { id, title }),
  deletePage: (id: string) => invoke<void>("delete_page", { id }),
  resolveConflict: (id: string, index: number, keep: number) =>
    invoke<Page>("resolve_conflict", { id, index, keep }),
};

export const events = {
  onSyncStatus: (handler: (status: SyncStatus) => void): Promise<UnlistenFn> =>
    listen<SyncStatus>("sync-status", (e) => handler(e.payload)),
  /** Files changed on disk: a sync pulled changes in, or another program edited them. */
  onWorkspaceChanged: (handler: () => void): Promise<UnlistenFn> => listen("workspace-changed", () => handler()),
};

/** Tauri rejects with the Rust error string. */
export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}
