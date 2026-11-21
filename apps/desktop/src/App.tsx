import { useCallback, useEffect, useRef, useState } from "react";
import { type PageSummary, type SyncStatus, type WorkspaceInfo, api, errorText, events } from "./api.ts";
import { PageView, type PageViewHandle } from "./PageView.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { Welcome } from "./Welcome.tsx";

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [starting, setStarting] = useState(true);

  useEffect(() => {
    api
      .restoreWorkspace()
      .then(setWorkspace)
      .finally(() => setStarting(false));
  }, []);

  if (starting) return <div className="splash" />;
  if (!workspace) return <Welcome onOpened={setWorkspace} />;
  return <WorkspaceView key={workspace.path} workspace={workspace} onChange={setWorkspace} />;
}

function WorkspaceView({ workspace, onChange }: { workspace: WorkspaceInfo; onChange: (w: WorkspaceInfo | null) => void }) {
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped when files change on disk, so the open page rereads its file.
  const [diskVersion, setDiskVersion] = useState(0);
  const page = useRef<PageViewHandle>(null);

  const reload = useCallback(async () => {
    try {
      setPages(await api.listPages());
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    const unlisten = [
      events.onSyncStatus(setStatus),
      events.onWorkspaceChanged(() => {
        void reload();
        setDiskVersion((n) => n + 1);
      }),
    ];
    // The first sync may have reported before we listened.
    void Promise.all(unlisten).then(() => api.syncStatus().then((s) => s && setStatus((now) => now ?? s)));
    return () => unlisten.forEach((u) => void u.then((f) => f()));
  }, [reload]);

  // Save before the window goes away or loses focus (and so before a sync on refocus).
  useEffect(() => {
    const flush = () => void page.current?.flush();
    window.addEventListener("blur", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("blur", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, []);

  // If the open page disappears (deleted here or by a sync), close it.
  useEffect(() => {
    if (selected && pages.length && !pages.some((p) => p.id === selected)) setSelected(null);
  }, [pages, selected]);

  const select = async (id: string | null) => {
    await page.current?.flush();
    setSelected(id);
  };

  const create = async (parent: string | null) => {
    try {
      await page.current?.flush();
      const id = await api.createPage("", parent);
      await reload();
      setSelected(id);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="layout">
      <Sidebar
        workspace={workspace}
        pages={pages}
        selected={selected}
        status={status}
        onSelect={select}
        onCreate={create}
        onWorkspaceChange={onChange}
        onError={setError}
      />
      <main className="main">
        {error && (
          <div className="banner banner-error" role="alert">
            <span>{error}</span>
            <button className="link" onClick={() => setError(null)}>Dismiss</button>
          </div>
        )}
        {selected ? (
          <PageView
            key={selected}
            ref={page}
            id={selected}
            diskVersion={diskVersion}
            onRenamed={reload}
            onDeleted={async () => {
              setSelected(null);
              await reload();
            }}
            onError={setError}
          />
        ) : (
          <div className="empty">
            <p>{pages.length ? "Pick a page on the left." : "This workspace has no pages yet."}</p>
            <button className="button" onClick={() => void create(null)}>New page</button>
          </div>
        )}
      </main>
    </div>
  );
}
