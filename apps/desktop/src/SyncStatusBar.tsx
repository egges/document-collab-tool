import { useEffect, useState } from "react";
import { type SyncStatus, type WorkspaceInfo, api } from "./api.ts";

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
  onSetRemote,
}: {
  workspace: WorkspaceInfo;
  status: SyncStatus | null;
  onWorkspaceChange: (w: WorkspaceInfo | null) => void;
  onSetRemote: (url: string | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState(workspace.remote ?? "");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => setRemote(workspace.remote ?? ""), [workspace.remote]);

  const [tone, label] = describe(status, workspace, now);
  return (
    <div className="sync">
      {open && (
        <div className="sync-panel">
          {status?.state === "offline" && (
            <p>Changes are saved on this device and sync when the connection is back.</p>
          )}
          {status?.state === "error" && <p>Changes are saved on this device. Syncing will try again shortly.</p>}
          {status?.message && <p className="sync-message">{status.message}</p>}
          {status?.conflicts ? (
            <p className="muted">
              The last sync kept both versions of {status.conflicts} edit{status.conflicts === 1 ? "" : "s"}. Pages with
              a conflict show it at the top.
            </p>
          ) : null}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void onSetRemote(remote.trim() || null);
            }}
          >
            <label className="field-label" htmlFor="remote">
              Sync with (Git URL)
            </label>
            <div className="row">
              <input
                id="remote"
                className="input"
                placeholder="git@github.com:you/notes.git"
                value={remote}
                onChange={(e) => setRemote(e.target.value)}
                spellCheck={false}
              />
              <button className="button" disabled={remote.trim() === (workspace.remote ?? "")}>
                Save
              </button>
            </div>
            <p className="muted small">
              An SSH URL or a local path. HTTPS needs GitHub sign-in, which isn't built yet.
            </p>
          </form>
          <dl className="facts">
            <dt>This device</dt>
            <dd>{workspace.device}</dd>
            <dt>Folder</dt>
            <dd title={workspace.path}>{workspace.path}</dd>
          </dl>
          <div className="row">
            <button className="button" disabled={!workspace.remote} onClick={() => void api.syncNow()}>
              Sync now
            </button>
            <button
              className="button"
              onClick={() => void api.closeWorkspace().finally(() => onWorkspaceChange(null))}
            >
              Close workspace
            </button>
          </div>
        </div>
      )}
      <button className="sync-bar" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={"dot " + tone} aria-hidden />
        <span>{label}</span>
      </button>
    </div>
  );
}
