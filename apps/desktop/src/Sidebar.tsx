import { useMemo, useState } from "react";
import { type PageSummary, type SyncStatus, type WorkspaceInfo, api, errorText } from "./api.ts";
import { SyncStatusBar } from "./SyncStatusBar.tsx";

interface SidebarProps {
  workspace: WorkspaceInfo;
  pages: PageSummary[];
  selected: string | null;
  status: SyncStatus | null;
  onSelect: (id: string) => void;
  onCreate: (parent: string | null) => void;
  onWorkspaceChange: (w: WorkspaceInfo | null) => void;
  onError: (message: string) => void;
  /** Set when the developer panel is available. */
  onOpenDevPanel?: () => void;
}

export function Sidebar(props: SidebarProps) {
  const { workspace, pages, selected, status } = props;
  const children = useMemo(() => {
    const map = new Map<string | null, PageSummary[]>();
    for (const page of pages) {
      const list = map.get(page.parent) ?? [];
      list.push(page);
      map.set(page.parent, list);
    }
    return map;
  }, [pages]);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="workspace-name" title={workspace.path}>
          {workspace.name}
        </span>
        <button className="icon-button" title="New page" aria-label="New page" onClick={() => props.onCreate(null)}>
          +
        </button>
      </div>
      <nav className="tree" aria-label="Pages">
        <ul className="tree-level" role="tree">
          {(children.get(null) ?? []).map((page) => (
            <TreeItem
              key={page.id}
              page={page}
              children={children}
              depth={0}
              selected={selected}
              onSelect={props.onSelect}
              onCreate={props.onCreate}
            />
          ))}
        </ul>
        {pages.length === 0 && <p className="muted tree-empty">No pages yet.</p>}
      </nav>
      {props.onOpenDevPanel && (
        <button className="dev-button" title="Developer log (⌘⇧D / Ctrl+Shift+D)" onClick={props.onOpenDevPanel}>
          Developer log
        </button>
      )}
      <SyncStatusBar
        workspace={workspace}
        status={status}
        onWorkspaceChange={props.onWorkspaceChange}
        onSetRemote={async (url) => {
          try {
            props.onWorkspaceChange(await api.setRemote(url));
          } catch (e) {
            props.onError(errorText(e));
          }
        }}
      />
    </aside>
  );
}

function TreeItem({
  page,
  children,
  depth,
  selected,
  onSelect,
  onCreate,
}: {
  page: PageSummary;
  children: Map<string | null, PageSummary[]>;
  depth: number;
  selected: string | null;
  onSelect: (id: string) => void;
  onCreate: (parent: string | null) => void;
}) {
  const [open, setOpen] = useState(true);
  const kids = children.get(page.id) ?? [];
  return (
    <li role="treeitem" aria-expanded={kids.length ? open : undefined} aria-selected={page.id === selected}>
      <div
        className={"tree-row" + (page.id === selected ? " selected" : "")}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect(page.id)}
      >
        <button
          className="disclosure"
          aria-label={open ? "Collapse" : "Expand"}
          style={{ visibility: kids.length ? "visible" : "hidden" }}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          {open ? "▾" : "▸"}
        </button>
        <span className={"tree-title" + (page.title ? "" : " untitled")}>{page.title || "Untitled"}</span>
        <button
          className="icon-button add-child"
          title="Add a page inside"
          aria-label="Add a page inside"
          onClick={(e) => {
            e.stopPropagation();
            onCreate(page.id);
          }}
        >
          +
        </button>
      </div>
      {open && kids.length > 0 && (
        <ul className="tree-level" role="group">
          {kids.map((kid) => (
            <TreeItem
              key={kid.id}
              page={kid}
              children={children}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
              onCreate={onCreate}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
