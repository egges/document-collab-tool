import { useEffect, useState } from "react";
import { FolderOpen, LogOut, RefreshCw } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type GitHubAccess, type SyncStatus, type WorkspaceInfo, api, errorText } from "./api.ts";
import { showInFolderLabel } from "./fileManager.ts";
import { GitHubSignIn, useGitHubAccount } from "./GitHubSignIn.tsx";
import { pickFolder } from "./menu.ts";
import { tip } from "./shortcuts.ts";

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
  onSetRemote,
}: {
  workspace: WorkspaceInfo;
  status: SyncStatus | null;
  onWorkspaceChange: (w: WorkspaceInfo | null) => void;
  /** Saves the open page, then opens the workspace `open` returns. */
  onSwitch: (open: () => Promise<WorkspaceInfo | null>) => Promise<void>;
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
          <GitHubSection workspace={workspace} onWorkspaceChange={onWorkspaceChange} />
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
                placeholder="https://github.com/you/notes.git"
                value={remote}
                onChange={(e) => setRemote(e.target.value)}
                spellCheck={false}
              />
              <button className="button" disabled={remote.trim() === (workspace.remote ?? "")}>
                Save
              </button>
            </div>
            <p className="muted small">
              An HTTPS or SSH URL, or a local path. GitHub HTTPS URLs use your GitHub sign-in.
            </p>
          </form>
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
    </div>
  );
}

/**
 * The GitHub account in the sync panel: sign in, and once signed in, give
 * a workspace that doesn't sync yet a private repository with one click.
 */
function GitHubSection({
  workspace,
  onWorkspaceChange,
}: {
  workspace: WorkspaceInfo;
  onWorkspaceChange: (w: WorkspaceInfo | null) => void;
}) {
  const [user, setUser] = useGitHubAccount();
  const [signingIn, setSigningIn] = useState(false);
  const [access, setAccess] = useState<GitHubAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; url?: string; link?: string } | null>(null);

  useEffect(() => {
    setAccess(null);
    if (!user) return;
    const check = () => void api.githubAccess().then(setAccess, () => setAccess(null));
    check();
    // Back from installing the app on GitHub.
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [user]);

  if (user === undefined) return null;

  const createRepo = async () => {
    setBusy(true);
    setNote(null);
    try {
      const created = await api.githubCreateRepo();
      onWorkspaceChange(created.workspace);
      setNote(
        created.reachable
          ? { text: `Syncing with the private repo ${created.fullName}.` }
          : {
              text: `Created ${created.fullName}. Pagemesh can only reach the repositories you chose, so add this one and it starts syncing.`,
              url: created.manageUrl,
              link: "Choose repositories…",
            },
      );
    } catch (e) {
      setNote({ text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!user) {
    return (
      <div className="github">
        <div className="row">
          <button className="button" onClick={() => setSigningIn(true)}>
            Sign in with GitHub
          </button>
        </div>
        <p className="muted small">Sync through a private GitHub repository, with nothing to set up.</p>
        {signingIn && (
          <GitHubSignIn
            onDone={(u) => {
              setSigningIn(false);
              setUser(u);
            }}
            onClose={() => setSigningIn(false)}
          />
        )}
      </div>
    );
  }

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
              .catch((e) => setNote({ text: errorText(e) }))
          }
        >
          Sign out
        </button>
      </div>
      {access && !access.installed && (
        <p className="muted small">
          To sync through GitHub, install Pagemesh on your account and choose which repositories it may use.{" "}
          <button type="button" className="link" onClick={() => void openUrl(access.manageUrl)}>
            Install it…
          </button>
        </p>
      )}
      {!workspace.remote && access?.installed !== false && (
        <button className="button primary" disabled={busy} onClick={() => void createRepo()}>
          {busy ? "Creating…" : "Create a private repo on GitHub"}
        </button>
      )}
      {note && (
        <p className="small" role="status">
          {note.text}{" "}
          {note.url && (
            <button type="button" className="link" onClick={() => void openUrl(note.url!)}>
              {note.link}
            </button>
          )}
        </p>
      )}
    </div>
  );
}
