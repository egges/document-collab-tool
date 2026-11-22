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

/** The GitHub account this device is signed in to. */
export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string;
}

/** A sign-in code to enter at `verificationUri`. */
export interface DeviceCode {
  userCode: string;
  verificationUri: string;
  /** Seconds until the code expires. */
  expiresIn: number;
}

/** Where the GitHub App is installed. */
export interface GitHubAccess {
  installed: boolean;
  allRepositories: boolean;
  /** Install it, or choose its repositories. */
  manageUrl: string;
}

/** A workspace on GitHub this device could join. */
export interface RemoteWorkspace {
  /** "ada/My-Notes". */
  fullName: string;
  name: string;
  cloneUrl: string;
}

export interface NewGitHubWorkspace {
  workspace: WorkspaceInfo;
  fullName: string | null;
  /** Why the repo wasn't created; the workspace is then only on this device. */
  problem: string | null;
  reachable: boolean;
  manageUrl: string | null;
}

export interface CreatedRepo {
  workspace: WorkspaceInfo;
  /** "ada/My-Notes". */
  fullName: string;
  /** False when the app can only reach chosen repositories and this isn't one yet. */
  reachable: boolean;
  manageUrl: string;
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
  githubAccount: () => invoke<GitHubUser | null>("github_account"),
  /** `attempt` is any number new to this run; pass it to finish and cancel too. */
  /** "browser" when this build signs in through the browser, "code" for the device flow. */
  githubSignInMode: () => invoke<"browser" | "code">("github_sign_in_mode"),
  /** Sign in through the browser, then install the app if needed; null when cancelled. */
  githubSignInBrowser: (attempt: number) => invoke<GitHubUser | null>("github_sign_in_browser", { attempt }),
  githubWorkspaces: () => invoke<RemoteWorkspace[]>("github_workspaces"),
  /** A new workspace that syncs with a new private repo. */
  createGitHubWorkspace: (name: string) => invoke<NewGitHubWorkspace>("create_github_workspace", { name }),
  githubSignInStart: (attempt: number) => invoke<DeviceCode>("github_sign_in_start", { attempt }),
  /** Waits until the code is approved on GitHub; null when cancelled. */
  githubSignInFinish: (attempt: number) => invoke<GitHubUser | null>("github_sign_in_finish", { attempt }),
  githubSignInCancel: (attempt: number) => invoke<void>("github_sign_in_cancel", { attempt }),
  githubSignOut: () => invoke<void>("github_sign_out"),
  githubAccess: () => invoke<GitHubAccess>("github_access"),
  /** A private repo for the open workspace, which then syncs with it. */
  githubCreateRepo: () => invoke<CreatedRepo>("github_create_repo"),
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
  /** Signed out without asking, e.g. the sign-in was revoked on GitHub. */
  onAccountChanged: (handler: () => void): Promise<UnlistenFn> => listen("account-changed", () => handler()),
  /** The browser sign-in moved on to GitHub's install page. */
  onGitHubSignInStep: (handler: (step: "install") => void): Promise<UnlistenFn> =>
    listen<"install">("github-sign-in-step", (e) => handler(e.payload)),
  onDevLog: (handler: (entry: LogEntry) => void): Promise<UnlistenFn> =>
    listen<LogEntry>("dev-log", (e) => handler(e.payload)),
};

/** Tauri rejects with the Rust error string. */
export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}
