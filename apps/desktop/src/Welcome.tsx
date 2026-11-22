import { useCallback, useEffect, useState } from "react";
import { FolderSearch, X } from "lucide-react";
import { type WorkspaceEntry, type WorkspaceInfo, api, errorText } from "./api.ts";
import { pickFolder } from "./menu.ts";

/** The workspaces to offer on the welcome screen: the known ones except the open one. */
export function otherWorkspaces(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return entries.filter((e) => !e.current);
}

/**
 * Shown when no workspace is open, and over the open one for "Add
 * workspace…" (then with `onCancel`): open a recent workspace, create one,
 * join one from a remote, or open a folder. New workspaces go in the app's
 * own data folder unless the user picks a location; "Show in Finder" in the
 * sync panel reveals it.
 */
export function Welcome({ onOpened, onCancel }: { onOpened: (w: WorkspaceInfo) => void; onCancel?: () => void }) {
  const [name, setName] = useState("My Notes");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<WorkspaceEntry[]>([]);

  const loadRecent = useCallback(
    () =>
      api
        .listWorkspaces()
        .then((entries) => setRecent(otherWorkspaces(entries)))
        .catch(() => setRecent([])),
    [],
  );
  useEffect(() => void loadRecent(), [loadRecent]);

  useEffect(() => {
    if (!onCancel) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const run = async (task: () => Promise<WorkspaceInfo | null>) => {
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
        <h1>{onCancel ? "Add a workspace" : "Your workspace"}</h1>
        <p className="muted">Pages are Markdown files in a folder, kept in sync between your devices with Git.</p>

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
                        onClick={() => void api.forgetWorkspace(entry.path).then(loadRecent)}
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

        <section className="card">
          <h2>Create a workspace</h2>
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
            <button className="button primary" disabled={busy}>
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

        <section className="card">
          <h2>Join a workspace from another device</h2>
          <p className="muted">
            Paste the Git URL it syncs with. SSH URLs and local paths work today; GitHub sign-in comes later.
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
              placeholder="git@github.com:you/notes.git"
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
        </section>

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
