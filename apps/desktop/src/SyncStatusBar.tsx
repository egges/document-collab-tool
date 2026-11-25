import { useEffect, useRef, useState } from "react";
import { CloudAlert, CloudCheck, CloudOff, Laptop, RefreshCw, Settings } from "lucide-react";
import { type SyncStatus, type WorkspaceInfo, api, errorText } from "./api.ts";
import { pickFolder, useDismiss } from "./menu.ts";
import { tip } from "./shortcuts.ts";
import { accessAdvice, folderName, isFolderRemote } from "./remotes.ts";
import { GitHubSignIn, useGitHubAccount } from "./GitHubSignIn.tsx";

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
function describe(
  status: SyncStatus | null,
  workspace: WorkspaceInfo,
  login: string | null,
  now: number,
): [string, string] {
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
    case "noAccess":
      return ["warn", accessAdvice(workspace.remote, login).label];
    case "error":
      return ["warn", "Sync paused"];
  }
}

/** A small picture of where the pages are: on this device, synced, or not reaching the others. */
function SyncIcon({
  status,
  workspace,
  tone,
  size = 15,
}: {
  status: SyncStatus | null;
  workspace: WorkspaceInfo;
  tone: string;
  size?: number;
}) {
  const state = status?.state ?? (workspace.remote ? "synced" : "localOnly");
  const Icon =
    state === "localOnly" ? Laptop : state === "offline" ? CloudOff : tone === "warn" ? CloudAlert : CloudCheck;
  return <Icon size={size} className={"sync-icon " + tone} aria-hidden />;
}

/**
 * Sync state at the bottom of the sidebar. Click it for a short popup: how
 * things stand, anything that needs doing, and Sync now. Everything else
 * about the workspace (where it's kept, its folder, the account) is in
 * Settings.
 */
export function SyncStatusBar({
  workspace,
  status,
  onWorkspaceChange,
  onSwitch,
  onOpenSettings,
}: {
  workspace: WorkspaceInfo;
  status: SyncStatus | null;
  onWorkspaceChange: (w: WorkspaceInfo | null) => void;
  /** Saves the open page, then opens the workspace `open` returns. */
  onSwitch: (open: () => Promise<WorkspaceInfo | null>) => Promise<void>;
  /** Opens the workspace's settings. */
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [user] = useGitHubAccount();
  const [signingIn, setSigningIn] = useState(false);
  const login = user?.login ?? null;
  const root = useRef<HTMLDivElement>(null);
  useDismiss(root, open, () => setOpen(false));
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const [described, label] = describe(status, workspace, login, now);
  const advice = accessAdvice(workspace.remote, login);
  // A workspace inside a cloud folder can get damaged, and one that moved
  // elsewhere no longer reaches the other devices: worth a warning colour.
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
    <div className="sync" ref={root}>
      {open && (
        <div className="sync-panel">
          <div className="sync-summary">
            <span className={"sync-badge " + tone} aria-hidden>
              <SyncIcon status={status} workspace={workspace} tone={tone} size={17} />
            </span>
            <div className="sync-summary-text">
              <span className="sync-summary-label">{label}</span>
              <span className="muted small">
                {workspace.keptIn ? `Kept in ${workspace.keptIn}` : "Kept on this computer only"}
              </span>
            </div>
          </div>
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
          {status?.state === "noAccess" && !workspace.movedTo && (
            <div className="sync-warning">
              <p>{advice.text}</p>
              {advice.action === "signIn" && (
                <button className="button primary" onClick={() => setSigningIn(true)}>
                  {login ? "Sign in again" : "Sign in with GitHub"}
                </button>
              )}
              {!advice.action && status.message && <p className="sync-message">{status.message}</p>}
            </div>
          )}
          {status?.state === "error" && (
            <>
              <p>Changes are saved on this device. Syncing will try again shortly.</p>
              {status.message && <p className="sync-message">{status.message}</p>}
            </>
          )}
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
          <div className="sync-actions">
            {workspace.remote && (
              <button className="button small" title={tip("Sync now", "syncNow")} onClick={() => void api.syncNow()}>
                <RefreshCw size={13} aria-hidden /> Sync now
              </button>
            )}
            <button
              className="button small"
              title="Where it's kept, its folder, and more"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              <Settings size={13} aria-hidden /> Settings
            </button>
          </div>
        </div>
      )}
      {signingIn && (
        <GitHubSignIn
          onDone={() => {
            // The account change starts a sync on its own.
            setSigningIn(false);
            setOpen(false);
          }}
          onClose={() => setSigningIn(false)}
        />
      )}
      <button className="sync-bar" aria-expanded={open} onClick={() => setOpen(!open)}>
        <SyncIcon status={status} workspace={workspace} tone={tone} />
        <span>{label}</span>
      </button>
    </div>
  );
}
