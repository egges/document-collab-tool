import { useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Keyboard, PanelLeftClose, Plus, Search, SquareTerminal } from "lucide-react";
import { type PageSummary, type SyncStatus, type WorkspaceInfo, api, errorText } from "./api.ts";
import { childrenOf } from "./pageTree.ts";
import { SHORTCUTS, keysLabel, tip } from "./shortcuts.ts";
import { SIDEBAR_WIDTH } from "./sidebarLayout.ts";
import { SyncStatusBar } from "./SyncStatusBar.tsx";
import { WorkspaceName } from "./WorkspaceName.tsx";

interface SidebarProps {
  workspace: WorkspaceInfo;
  pages: PageSummary[];
  selected: string | null;
  status: SyncStatus | null;
  onSelect: (id: string) => void;
  onCreate: (parent: string | null) => void;
  onWorkspaceChange: (w: WorkspaceInfo | null) => void;
  onError: (message: string) => void;
  onShowShortcuts: () => void;
  onSearch: () => void;
  width: number;
  hidden: boolean;
  onResize: (width: number) => void;
  onHide: () => void;
  /** Set when the developer panel is available. */
  onOpenDevPanel?: () => void;
}

export function Sidebar(props: SidebarProps) {
  const { workspace, pages, selected, status } = props;
  const children = useMemo(() => childrenOf(pages), [pages]);

  return (
    <aside className="sidebar" hidden={props.hidden}>
      <div className="sidebar-header">
        <WorkspaceName workspace={workspace} onRenamed={props.onWorkspaceChange} onError={props.onError} />
        <button
          className="icon-button sidebar-hide"
          title={tip("Hide the sidebar", "toggleSidebar")}
          aria-label="Hide the sidebar"
          onClick={props.onHide}
        >
          <PanelLeftClose size={16} />
        </button>
        <button className="icon-button" title={tip("New page", "newPage")} aria-label="New page" onClick={() => props.onCreate(null)}>
          <Plus size={16} />
        </button>
      </div>
      <button className="sidebar-search" title={tip("Search", "search")} onClick={props.onSearch}>
        <Search size={14} aria-hidden />
        <span>Search</span>
        <kbd>{keysLabel(SHORTCUTS.search.keys)}</kbd>
      </button>
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
      <div className="sidebar-footer">
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
        <button
          className="icon-button"
          title={tip("Keyboard shortcuts", "showShortcuts")}
          aria-label="Keyboard shortcuts"
          onClick={props.onShowShortcuts}
        >
          <Keyboard size={15} />
        </button>
        {props.onOpenDevPanel && (
          <button
            className="icon-button"
            title={tip("Developer log", "toggleDevPanel")}
            aria-label="Developer log"
            onClick={props.onOpenDevPanel}
          >
            <SquareTerminal size={15} />
          </button>
        )}
      </div>
      <Resizer width={props.width} onResize={props.onResize} />
    </aside>
  );
}

/** The sidebar's right edge: drag to resize, double-click for the default width, or arrow keys. */
function Resizer({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width };
        document.body.classList.add("resizing");
      }}
      onPointerMove={(e) => {
        if (drag.current) onResize(drag.current.width + e.clientX - drag.current.x);
      }}
      onPointerUp={(e) => {
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        document.body.classList.remove("resizing");
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        document.body.classList.remove("resizing");
      }}
      onDoubleClick={() => onResize(SIDEBAR_WIDTH.default)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        if (e.key === "ArrowLeft") onResize(width - step);
        else if (e.key === "ArrowRight") onResize(width + step);
        else return;
        e.preventDefault();
      }}
    />
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
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
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
          <Plus size={14} />
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
