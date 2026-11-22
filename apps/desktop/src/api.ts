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

/** A workspace this device knows, for the switcher. */
export interface WorkspaceEntry {
  path: string;
  /** Read fresh when the folder is there, else the name last seen. */
  name: string;
  /** The folder is gone or no longer holds a workspace: offer "Locate…". */
  missing: boolean;
  /** Open in the window now. */
  current: boolean;
  /** Milliseconds since the Unix epoch. */
  lastOpened: number;
}

export interface PageSummary {
  id: string;
  title: string;
  /** Never points at a missing page: orphans come back as top-level pages. */
  parent: string | null;
}

/** A place in a page's text where a search query appears. */
export interface TextMatch {
  page: string;
  before: string;
  matched: string;
  after: string;
  /** How many times the query appears in the page. */
  count: number;
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
  /** A new workspace in the app's own data folder. */
  createWorkspace: (name: string) => invoke<WorkspaceInfo>("create_workspace", { name }),
  /** Join from `url`, keeping this device's copy in the app's own data folder. */
  joinWorkspace: (url: string) => invoke<WorkspaceInfo>("join_workspace", { url }),
  showWorkspaceFolder: () => invoke<void>("show_workspace_folder"),
  /** The open workspace, read fresh: a sync may have renamed it. */
  workspaceInfo: () => invoke<WorkspaceInfo | null>("workspace_info"),
  /** Rename the workspace on every device; folders and remotes keep their names. */
  renameWorkspace: (name: string) => invoke<WorkspaceInfo>("rename_workspace", { name }),
  closeWorkspace: () => invoke<void>("close_workspace"),
  /** Known workspaces, most recently opened first. */
  listWorkspaces: () => invoke<WorkspaceEntry[]>("list_workspaces"),
  /** Take a workspace off the list; its files stay where they are. */
  forgetWorkspace: (path: string) => invoke<void>("forget_workspace", { path }),
  /** The workspace listed at `from` is now in `to`: open it there. */
  locateWorkspace: (from: string, to: string) => invoke<WorkspaceInfo>("locate_workspace", { from, to }),
  /**
   * Move the open workspace into a new folder inside `parent`. On failure
   * it reopens where it was (or nothing is open): ask `workspaceInfo`.
   */
  moveWorkspace: (parent: string) => invoke<WorkspaceInfo>("move_workspace", { parent }),
  setRemote: (url: string | null) => invoke<WorkspaceInfo>("set_remote", { url }),
  syncStatus: () => invoke<SyncStatus | null>("sync_status"),
  syncNow: () => invoke<void>("sync_now"),
  listPages: () => invoke<PageSummary[]>("list_pages"),
  readPage: (id: string) => invoke<Page>("read_page", { id }),
  searchText: (query: string) => invoke<TextMatch[]>("search_text", { query }),
  writePage: (id: string, base: string, body: string) => invoke<WriteResult>("write_page", { id, base, body }),
  createPage: (title: string, parent: string | null) => invoke<string>("create_page", { title, parent }),
  renamePage: (id: string, title: string) => invoke<void>("rename_page", { id, title }),
  deletePage: (id: string) => invoke<void>("delete_page", { id }),
  resolveConflict: (id: string, index: number, keep: number) =>
    invoke<Page>("resolve_conflict", { id, index, keep }),
};

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  id: number;
  /** Milliseconds since the Unix epoch. */
  time: number;
  level: LogLevel;
  source: string;
  message: string;
}

export interface DevInfo {
  /** Whether the developer panel is available (debug builds, or DOCSYNC_DEV=1). */
  enabled: boolean;
  version: string;
  debugBuild: boolean;
  os: string;
  git: string | null;
  workspace: WorkspaceInfo | null;
}

export const devApi = {
  info: () => invoke<DevInfo>("dev_info"),
  entries: () => invoke<LogEntry[]>("dev_log_entries"),
  clear: () => invoke<void>("dev_log_clear"),
  add: (level: LogLevel, source: string, message: string) => invoke<void>("dev_log_add", { level, source, message }),
};

export const events = {
  onSyncStatus: (handler: (status: SyncStatus) => void): Promise<UnlistenFn> =>
    listen<SyncStatus>("sync-status", (e) => handler(e.payload)),
  /** Files changed on disk: a sync pulled changes in, or another program edited them. */
  onWorkspaceChanged: (handler: () => void): Promise<UnlistenFn> => listen("workspace-changed", () => handler()),
  onDevLog: (handler: (entry: LogEntry) => void): Promise<UnlistenFn> =>
    listen<LogEntry>("dev-log", (e) => handler(e.payload)),
};

/** Tauri rejects with the Rust error string. */
export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}
