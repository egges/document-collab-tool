import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { type WorkspaceInfo, api, errorText } from "./api.ts";

/**
 * Shown when no workspace is open: create one, join one from a remote, or
 * open a folder. New workspaces go in the app's own data folder unless the
 * user picks a location; "Show in Finder" in the sync panel reveals it.
 */
export function Welcome({ onOpened }: { onOpened: (w: WorkspaceInfo) => void }) {
  const [name, setName] = useState("My Notes");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const pickFolder = async (title: string) => {
    const path = await open({ directory: true, title });
    return typeof path === "string" ? path : null;
  };

  return (
    <div className="welcome">
      <h1>Your workspace</h1>
      <p className="muted">Pages are Markdown files in a folder, kept in sync between your devices with Git.</p>

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
  );
}
