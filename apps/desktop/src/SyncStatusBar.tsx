import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FolderOpen, LogOut, RefreshCw } from "lucide-react";
import { type SyncStatus, type WorkspaceInfo, api, errorText } from "./api.ts";
import { showInFolderLabel } from "./fileManager.ts";
import { useGitHubAccount } from "./GitHubSignIn.tsx";
import { pickFolder } from "./menu.ts";
import { tip } from "./shortcuts.ts";
import { folderName, isFolderRemote } from "./remotes.ts";
import { Welcome } from "./Welcome.tsx";

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Sync should go unnoticed: a calm "Synced" while all is well (including
 * during the sync every 45 seconds), and a coloured dot only when changes
 * aren't reaching other devices.
 */
function describe(status: SyncStatus | null, workspace: WorkspaceInfo, now: number): [string, string] {
  const synced = status?.lastSynced ? `Synced ${ago(status.lastSynced, now)}` : "Synced";
  if (!status) return ["", workspace.remote ? "Synced" : "Only on this device"];
  switch (status.state) {
    case "localOnly":
      return ["", "Only on this device"];
    case "syncing":
    case "synced":
      return ["", synced];
    case "offline":
      return ["warn", "Offline"];
    case "error":
      return ["warn", "Sync paused"];
  }
}

/** Sync state at the bottom of the sidebar; click it for sync settings. */
export function SyncStatusBar({
  workspace,
  status,
  onWorkspaceChange,
  onSwitch,
}: {
  workspace: WorkspaceInfo;
  status: SyncStatus | null;
  onWorkspaceChange: (w: WorkspaceInfo | null) => void;
  /** Saves the open page, then opens the workspace `open` returns. */
  onSwitch: (open: () => Promise<WorkspaceInfo | null>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  // The wizard's "change where it syncs", over the whole window.
  const [changing, setChanging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const [described, label] = describe(status, workspace, now);
  // A workspace inside a cloud folder can get damaged, and one that moved
  // elsewhere no longer reaches the other devices: worth a dot.
  const tone = workspace.insideCloud || workspace.movedTo ? "warn" : described;
  const locate = async (name: string) => {
    const folder = await pickFolder(`Where is “${name}” now?`);
    if (!folder) return;
    setProblem(null);
    try {
      onWorkspaceChange(await api.locateSyncFolder(folder));
    } catch (e) {
      setProblem(errorText(e));
    }
  };
  return (
    <div className="sync">
      {open && (
        <div className="sync-panel">
          {status?.state === "offline" &&
            !workspace.movedTo &&
            (isFolderRemote(workspace.remote) ? (
              <div className="sync-warning">
                <p>Can't reach the sync folder. Changes are saved on this device and sync once it's back.</p>
                <p className="small">
                  If it's on a drive, connect it. If you moved it, show Pagemesh where it is now.
                </p>
                <button className="button" onClick={() => void locate(folderName(workspace.remote!))}>
                  Locate…
                </button>
                {problem && <p className="error small">{problem}</p>}
              </div>
            ) : (
              <p>Changes are saved on this device and sync when the connection is back.</p>
            ))}
          {status?.state === "error" && <p>Changes are saved on this device. Syncing will try again shortly.</p>}
          {status?.message && <p className="sync-message">{status.message}</p>}
          {status?.conflicts ? (
            <p className="muted">
              The last sync kept both versions of {status.conflicts} edit{status.conflicts === 1 ? "" : "s"}. Pages with
              a conflict show it at the top.
            </p>
          ) : null}
          {workspace.movedTo && (
            <div className="sync-warning">
              <p>
                Another device moved this workspace to {workspace.movedTo.label}. This device follows as soon as it can
                reach it; until then, its changes don't reach the devices that moved.
              </p>
              {workspace.movedTo.folder ? (
                <>
                  <p className="small">If that folder is on this computer, show Pagemesh where.</p>
                  <button className="button" onClick={() => void locate(workspace.name)}>
                    Locate…
                  </button>
                </>
              ) : (
                <p className="small">Check that this device is signed in and has access to it.</p>
              )}
              {problem && <p className="error small">{problem}</p>}
            </div>
          )}
          {workspace.insideCloud && (
            <div className="sync-warning">
              <p>
                This workspace's folder is inside {workspace.insideCloud}, which can damage it: {workspace.insideCloud}{" "}
                and Pagemesh would both sync the same files.
              </p>
              <button
                className="button primary"
                onClick={() => {
                  setOpen(false);
                  void onSwitch(() => api.moveOutOfCloud());
                }}
              >
                {workspace.remote
                  ? `Move it out of ${workspace.insideCloud}`
                  : `Move it out and sync through ${workspace.insideCloud}`}
              </button>
            </div>
          )}
          <div className="sync-target">
            <div className="sync-target-text">
              <span className="muted small">Kept in</span>
              <span title={workspace.remote ?? undefined}>{workspace.keptIn ?? "On this computer"}</span>
            </div>
            <button
              className="button"
              onClick={() => {
                setOpen(false);
                setChanging(true);
              }}
            >
              Change…
            </button>
          </div>
          <GitHubAccountRow />
          <dl className="facts">
            <dt>This device</dt>
            <dd>{workspace.device}</dd>
            <dt>Folder</dt>
            <dd title={workspace.path}>
              <button type="button" className="link folder-path" onClick={() => void api.showWorkspaceFolder()}>
                {workspace.path}
              </button>
              <button
                type="button"
                className="link"
                title="Move the workspace's files to another folder on this device"
                onClick={() =>
                  void (async () => {
                    const parent = await pickFolder(`Move “${workspace.name}” into…`);
                    if (!parent) return;
                    setOpen(false);
                    await onSwitch(() => api.moveWorkspace(parent));
                  })()
                }
              >
                Move…
              </button>
            </dd>
          </dl>
          <div className="row">
            <button
              className="icon-button"
              aria-label="Sync now"
              title={tip("Sync now", "syncNow")}
              disabled={!workspace.remote}
              onClick={() => void api.syncNow()}
            >
              <RefreshCw size={15} />
            </button>
            <button
              className="icon-button"
              aria-label={showInFolderLabel()}
              title={showInFolderLabel()}
              onClick={() => void api.showWorkspaceFolder()}
            >
              <FolderOpen size={15} />
            </button>
            <span className="spacer" />
            <button
              className="icon-button"
              aria-label="Close workspace"
              title="Close workspace"
              onClick={() => void api.closeWorkspace().finally(() => onWorkspaceChange(null))}
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      )}
      <button className="sync-bar" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={"dot " + tone} aria-hidden />
        <span>{label}</span>
      </button>
      {changing &&
        createPortal(
          <Welcome
            change={workspace}
            onOpened={(w) => {
              setChanging(false);
              onWorkspaceChange(w);
            }}
            onCancel={() => setChanging(false)}
          />,
          document.body,
        )}
    </div>
  );
}

/** The GitHub account this device is signed in with, to sign out. */
function GitHubAccountRow() {
  const [user, setUser] = useGitHubAccount();
  const [problem, setProblem] = useState<string | null>(null);
  if (!user) return null;
  return (
    <div className="github">
      <div className="github-account">
        <img className="avatar" src={user.avatarUrl} alt="" width={20} height={20} />
        <span className="github-name" title={`Signed in to GitHub as @${user.login}`}>
          {user.name?.trim() || user.login} <span className="muted">@{user.login}</span>
        </span>
        <button
          type="button"
          className="link"
          title="Sign out on this device. Commits from now on are by this device."
          onClick={() =>
            void api
              .githubSignOut()
              .then(() => setUser(null))
              .catch((e) => setProblem(errorText(e)))
          }
        >
          Sign out
        </button>
      </div>
      {problem && <p className="error small">{problem}</p>}
    </div>
  );
}
