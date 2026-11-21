import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { type WorkspaceInfo, api, errorText } from "./api.ts";

/** Shown when no workspace is open: open or create one, or join one from a remote. */
export function Welcome({ onOpened }: { onOpened: (w: WorkspaceInfo) => void }) {
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
        <h2>Open or create a workspace</h2>
        <p className="muted">Pick a folder that holds a workspace, or an empty folder to start a new one.</p>
        <button
          className="button primary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const path = await pickFolder("Open or create a workspace");
              return path ? api.openWorkspace(path) : null;
            })
          }
        >
          Choose folder…
        </button>
      </section>

      <section className="card">
        <h2>Join a workspace from another device</h2>
        <p className="muted">
          Paste the Git URL it syncs with, then pick an empty folder for this device's copy. SSH URLs and local paths
          work today; GitHub sign-in comes later.
        </p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const path = await pickFolder("Choose an empty folder for the workspace");
              return path ? api.cloneWorkspace(url, path) : null;
            });
          }}
        >
          <input
            className="input"
            placeholder="git@github.com:you/notes.git"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
          />
          <button className="button" disabled={busy || !url.trim()}>
            Join…
          </button>
        </form>
      </section>

      {busy && <p className="muted">Working…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
