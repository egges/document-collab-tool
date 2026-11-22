import { useCallback, useEffect, useState } from "react";
import { FolderSearch, X } from "lucide-react";
import { message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type GitHubAccess,
  type GitHubUser,
  type RemoteWorkspace,
  type WorkspaceEntry,
  type WorkspaceInfo,
  api,
  errorText,
} from "./api.ts";
import { GitHubSignIn, useGitHubAccount } from "./GitHubSignIn.tsx";
import { pickFolder } from "./menu.ts";

/** The workspaces to offer on the welcome screen: the known ones except the open one. */
export function otherWorkspaces(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return entries.filter((e) => !e.current);
}

/** Workspaces on GitHub that this device doesn't have yet. */
export function joinable(remote: RemoteWorkspace[], known: WorkspaceEntry[]): RemoteWorkspace[] {
  const names = new Set(known.filter((k) => !k.missing).map((k) => k.name.toLowerCase()));
  return remote.filter((r) => !names.has(r.name.toLowerCase()));
}

type Run = (task: () => Promise<WorkspaceInfo | null>) => Promise<void>;

/**
 * Onboarding: shown when no workspace is open, and over the open one for
 * "Add workspace…" (then with `onCancel`). It asks where notes should sync:
 * GitHub (sign in, then join a workspace that's there or create one with a
 * private repo), or only this device. Other ways (a Git URL, a folder) sit
 * under "Other ways to start". New workspaces go in the app's own data
 * folder unless the user picks a location.
 */
export function Welcome({ onOpened, onCancel }: { onOpened: (w: WorkspaceInfo) => void; onCancel?: () => void }) {
  const [name, setName] = useState("My Notes");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [known, setKnown] = useState<WorkspaceEntry[]>([]);
  const recent = otherWorkspaces(known);

  const loadKnown = useCallback(
    () =>
      api
        .listWorkspaces()
        .then(setKnown)
        .catch(() => setKnown([])),
    [],
  );
  useEffect(() => void loadKnown(), [loadKnown]);

  useEffect(() => {
    if (!onCancel) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const run: Run = async (task) => {
    setBusy(true);
    setError(null);
    try {
      const workspace = await task();
      if (workspace) onOpened(workspace);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={"welcome-screen" + (onCancel ? " over-workspace" : "")}>
      <div className="welcome">
        {/* No title bar here: the top of the window still moves it. */}
        <div className="window-drag" data-window-drag />
        {onCancel && (
          <button className="icon-button welcome-close" aria-label="Close" title="Close (Esc)" onClick={onCancel}>
            <X size={16} />
          </button>
        )}
        <h1>{onCancel ? "Add a workspace" : "Welcome to Pagemesh"}</h1>
        <p className="muted">
          Your pages are Markdown files on this device, kept in a workspace. Where should it sync?
        </p>

        {recent.length > 0 && (
          <section className="card">
            <h2>{onCancel ? "Your other workspaces" : "Recent workspaces"}</h2>
            <ul className="recent">
              {recent.map((entry) => (
                <li key={entry.path} className={"recent-row" + (entry.missing ? " missing" : "")}>
                  <button
                    className="recent-open"
                    disabled={busy}
                    title={entry.missing ? `Not found at ${entry.path}` : entry.path}
                    onClick={() =>
                      void run(async () => {
                        if (!entry.missing) return api.openWorkspace(entry.path);
                        const path = await pickFolder(`Where is “${entry.name}” now?`);
                        return path ? api.locateWorkspace(entry.path, path) : null;
                      })
                    }
                  >
                    <span className="recent-name">{entry.name}</span>
                    <span className="recent-path muted small">
                      {entry.missing ? "Not found: click to locate it" : entry.path}
                    </span>
                  </button>
                  {entry.missing && (
                    <>
                      <FolderSearch size={14} className="muted" aria-hidden />
                      <button
                        className="icon-button"
                        title="Remove from this list (doesn't delete anything)"
                        aria-label={`Remove “${entry.name}” from the list`}
                        onClick={() => void api.forgetWorkspace(entry.path).then(loadKnown)}
                      >
                        <X size={14} />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <GitHubCard name={name} setName={setName} known={known} busy={busy} run={run} />

        <section className="card">
          <h2>Only on this device</h2>
          <p className="muted">Nothing leaves this device. You can still sync it later from the sync panel.</p>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api.createWorkspace(name));
            }}
          >
            <input
              className="input"
              aria-label="Workspace name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button className="button" disabled={busy || !name.trim()}>
              Create
            </button>
          </form>
          <p className="muted small welcome-alt">
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const path = await pickFolder("Choose an empty folder for the workspace");
                  return path ? api.openWorkspace(path) : null;
                })
              }
            >
              Choose location…
            </button>
          </p>
        </section>

        <details className="card more">
          <summary>Other ways to start</summary>
          <h2>Join from a Git URL</h2>
          <p className="muted">
            HTTPS or SSH, or a local path. GitHub HTTPS URLs use your GitHub sign-in.
          </p>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api.joinWorkspace(url));
            }}
          >
            <input
              className="input"
              aria-label="Git URL"
              placeholder="https://github.com/you/notes.git"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              spellCheck={false}
            />
            <button className="button" disabled={busy || !url.trim()}>
              Join
            </button>
          </form>
          <p className="muted small welcome-alt">
            <button
              type="button"
              className="link"
              disabled={busy || !url.trim()}
              onClick={() =>
                void run(async () => {
                  const path = await pickFolder("Choose an empty folder for the workspace");
                  return path ? api.cloneWorkspace(url, path) : null;
                })
              }
            >
              Join into a folder you choose…
            </button>
          </p>
          <p className="muted small">
            Already have a workspace folder?{" "}
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const path = await pickFolder("Open a workspace");
                  return path ? api.openWorkspace(path) : null;
                })
              }
            >
              Open folder…
            </button>
          </p>
        </details>

        {busy && <p className="muted">Working…</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * GitHub in onboarding. Signed out: one "Continue with GitHub" for new and
 * returning users (see `GitHubSignIn`). Signed in: the workspaces
 * already on GitHub to join, and a new one with a private repo.
 */
function GitHubCard({
  name,
  setName,
  known,
  busy,
  run,
}: {
  name: string;
  setName: (name: string) => void;
  known: WorkspaceEntry[];
  busy: boolean;
  run: Run;
}) {
  const [user, setUser] = useGitHubAccount();
  const [signingIn, setSigningIn] = useState(false);
  const [remote, setRemote] = useState<RemoteWorkspace[] | null>(null);
  const [access, setAccess] = useState<GitHubAccess | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setRemote(null);
    setAccess(null);
    setProblem(null);
    if (!user) return;
    const load = () => {
      void api.githubAccess().then(setAccess, () => setAccess(null));
      void api.githubWorkspaces().then(setRemote, (e) => {
        setRemote([]);
        setProblem(errorText(e));
      });
    };
    load();
    // Back from installing the app or changing its repositories on GitHub.
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [user]);

  if (user === undefined) return null;

  const dialog = signingIn && (
    <GitHubSignIn
      onDone={(u: GitHubUser) => {
        setSigningIn(false);
        setUser(u);
      }}
      onClose={() => {
        setSigningIn(false);
        // Cancelling while installing still leaves them signed in.
        void api.githubAccount().then(setUser, () => undefined);
      }}
    />
  );

  if (!user) {
    return (
      <section className="card github-card">
        <h2>
          Sync with GitHub <span className="badge">Recommended</span>
        </h2>
        <p className="muted">
          Your workspace in a private GitHub repository, on all your devices. Pagemesh only gets the repositories you
          choose.
        </p>
        <div className="row">
          <button className="button primary" disabled={busy} onClick={() => setSigningIn(true)}>
            Continue with GitHub
          </button>
        </div>
        {dialog}
      </section>
    );
  }

  const toJoin = remote && joinable(remote, known);
  const createOnGitHub = () =>
    run(async () => {
      const created = await api.createGitHubWorkspace(name);
      if (created.problem) {
        await message(`“${created.workspace.name}” is only on this device for now: ${created.problem}`, {
          title: "Couldn't create the GitHub repository",
          kind: "warning",
        });
      } else if (!created.reachable && created.manageUrl) {
        await message(
          `Created ${created.fullName}. Pagemesh can only reach the repositories you chose: add this one on GitHub and it starts syncing.`,
          { title: "One more step on GitHub", kind: "info" },
        );
        await openUrl(created.manageUrl);
      }
      return created.workspace;
    });

  return (
    <section className="card github-card">
      <div className="github-account">
        <img className="avatar" src={user.avatarUrl} alt="" width={20} height={20} />
        <span className="github-name">
          {user.name?.trim() || user.login} <span className="muted">@{user.login}</span>
        </span>
        <button type="button" className="link" onClick={() => void api.githubSignOut().then(() => setUser(null))}>
          Sign out
        </button>
      </div>

      {access && !access.installed ? (
        <>
          <p className="muted">Install Pagemesh on your GitHub account and choose which repositories it may use.</p>
          <div className="row">
            <button className="button primary" onClick={() => void openUrl(access.manageUrl)}>
              Install on GitHub…
            </button>
          </div>
        </>
      ) : (
        <>
          {remote === null ? (
            <p className="muted small">Looking for your workspaces on GitHub…</p>
          ) : (
            toJoin &&
            toJoin.length > 0 && (
              <>
                <h2>Your workspaces on GitHub</h2>
                <ul className="recent">
                  {toJoin.map((w) => (
                    <li key={w.fullName} className="recent-row">
                      <button
                        className="recent-open"
                        disabled={busy}
                        title={`Join ${w.fullName} on this device`}
                        onClick={() => void run(() => api.joinWorkspace(w.cloneUrl))}
                      >
                        <span className="recent-name">{w.name}</span>
                        <span className="recent-path muted small">{w.fullName}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )
          )}
          <h2>{toJoin && toJoin.length > 0 ? "Or start a new workspace" : "Start a new workspace"}</h2>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void createOnGitHub();
            }}
          >
            <input
              className="input"
              aria-label="Workspace name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button className="button primary" disabled={busy || !name.trim()}>
              Create
            </button>
          </form>
          <p className="muted small">It syncs with a new private repository on your GitHub account.</p>
          {access && !access.allRepositories && (
            <p className="muted small">
              Don't see a workspace? Pagemesh only sees the repositories you chose.{" "}
              <button type="button" className="link" onClick={() => void openUrl(access.manageUrl)}>
                Choose repositories…
              </button>
            </p>
          )}
        </>
      )}
      {problem && <p className="error small">{problem}</p>}
      {dialog}
    </section>
  );
}
