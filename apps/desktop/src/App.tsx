import { useCallback, useEffect, useRef, useState } from "react";
import { PanelLeftOpen, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type PageSummary, type SyncStatus, type WorkspaceInfo, api, errorText, events } from "./api.ts";
import { DevPanel, useDevPanel } from "./DevPanel.tsx";
import { log } from "./devlog.ts";
import { PageView, type PageViewHandle } from "./PageView.tsx";
import { linkTarget } from "./links.ts";
import { displayOrder } from "./pageTree.ts";
import { Search } from "./Search.tsx";
import type { SearchAction } from "./search.ts";
import { inCodeBlock, tip, useShortcuts } from "./shortcuts.ts";
import { ShortcutsHelp } from "./ShortcutsHelp.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { useSidebarLayout } from "./sidebarLayout.ts";
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
  // Text to select once the open page loads, when it was opened from a search.
  const [reveal, setReveal] = useState<string | null>(null);
  const sidebar = useSidebarLayout();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setErrorState] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"search" | "shortcuts" | null>(null);
  const setError = useCallback((message: string | null) => {
    if (message) log("error", "ui", `Shown to the user: ${message}`);
    setErrorState(message);
  }, []);
  const dev = useDevPanel();
  // Bumped when files change on disk, so the open page rereads its file.
  const [diskVersion, setDiskVersion] = useState(0);
  const page = useRef<PageViewHandle>(null);
  const nameRef = useRef(workspace.name);
  nameRef.current = workspace.name;

  const reload = useCallback(async () => {
    try {
      setPages(await api.listPages());
    } catch (e) {
      setError(errorText(e));
    }
  }, [setError]);

  useEffect(() => {
    void reload();
    const unlisten = [
      events.onSyncStatus(setStatus),
      events.onWorkspaceChanged(() => {
        log("debug", "ui", "Workspace changed on disk: reloading the page list and the open page");
        void reload();
        setDiskVersion((n) => n + 1);
        // Another device may have renamed the workspace.
        void api.workspaceInfo().then((w) => w && w.name !== nameRef.current && onChange(w));
      }),
    ];
    // The first sync may have reported before we listened.
    void Promise.all(unlisten).then(() => api.syncStatus().then((s) => s && setStatus((now) => now ?? s)));
    return () => unlisten.forEach((u) => void u.then((f) => f()));
  }, [reload, setError, onChange]);

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

  const select = async (id: string | null, find: string | null = null) => {
    await page.current?.flush();
    setReveal(find);
    setSelected(id);
  };

  const create = async (parent: string | null, title = "") => {
    try {
      await page.current?.flush();
      const id = await api.createPage(title, parent);
      await reload();
      setReveal(null);
      setSelected(id);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const step = (by: 1 | -1) => {
    const order = displayOrder(pages);
    if (!order.length) return;
    const at = order.findIndex((p) => p.id === selected);
    const next = at < 0 ? (by > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, at + by));
    void select(order[next].id);
  };

  const runSearch = (action: SearchAction) => {
    setDialog(null);
    if (action.kind === "openPage") void select(action.id, action.reveal ?? null);
    else void create(null, action.title);
  };

  const openLink = (href: string) => {
    const target = linkTarget(href, pages);
    log("info", "ui", `Link clicked: ${href} (${target.kind})`);
    if (target.kind === "page") void select(target.id);
    else if (target.kind === "external") openUrl(target.url).catch((e) => setError(`Couldn't open ${target.url}: ${errorText(e)}`));
  };

  useShortcuts({
    search: () => setDialog((d) => (d === "search" ? null : "search")),
    toggleSidebar: sidebar.toggle,
    // In a code block, ⌘/ comments lines out, as in a code editor.
    showShortcuts: () => (inCodeBlock() ? false : setDialog((d) => (d === "shortcuts" ? null : "shortcuts"))),
    newPage: () => void create(null),
    newSubpage: selected ? () => void create(selected) : undefined,
    previousPage: () => step(-1),
    nextPage: () => step(1),
    deletePage: selected ? () => void page.current?.remove() : undefined,
    syncNow: () => {
      log("info", "ui", "Save and sync requested from the keyboard");
      void page.current?.flush().then(() => api.syncNow());
    },
    toggleDevPanel: dev.enabled ? dev.toggle : undefined,
    toggleDevPanelSize: dev.enabled ? dev.toggleSize : undefined,
  });

  return (
    <div
      className={"layout" + (sidebar.hidden ? " sidebar-hidden" : "")}
      style={{ gridTemplateColumns: sidebar.hidden ? "1fr" : `${sidebar.width}px 1fr` }}
    >
      <Sidebar
        workspace={workspace}
        pages={pages}
        selected={selected}
        status={status}
        onSelect={select}
        onCreate={create}
        onWorkspaceChange={onChange}
        onError={setError}
        onShowShortcuts={() => setDialog("shortcuts")}
        onSearch={() => setDialog("search")}
        width={sidebar.width}
        hidden={sidebar.hidden}
        onResize={sidebar.setWidth}
        onHide={sidebar.toggle}
        onOpenDevPanel={dev.enabled ? dev.toggle : undefined}
      />
      <main className="main">
        {sidebar.hidden && (
          <button
            className="icon-button sidebar-show"
            title={tip("Show the sidebar", "toggleSidebar")}
            aria-label="Show the sidebar"
            onClick={sidebar.toggle}
          >
            <PanelLeftOpen size={16} />
          </button>
        )}
        {error && (
          <div className="banner banner-error" role="alert">
            <span>{error}</span>
            <button className="icon-button" aria-label="Dismiss" title="Dismiss" onClick={() => setError(null)}>
              <X size={14} />
            </button>
          </div>
        )}
        {selected ? (
          <PageView
            key={selected}
            ref={page}
            id={selected}
            diskVersion={diskVersion}
            reveal={reveal}
            onOpenLink={openLink}
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
            <button className="button" onClick={() => void create(null)}>
              New page
            </button>
          </div>
        )}
      </main>
      {dev.open && <DevPanel maximized={dev.maximized} onToggleSize={dev.toggleSize} onClose={dev.toggle} />}
      {dialog === "search" && <Search pages={pages} onAction={runSearch} onClose={() => setDialog(null)} />}
      {dialog === "shortcuts" && <ShortcutsHelp devPanel={dev.enabled} onClose={() => setDialog(null)} />}
    </div>
  );
}
