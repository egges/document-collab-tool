// The window's title bar, drawn by the app: one strip across the top of the
// sidebar and one across the page, the same height, so they read as one bar.
// Empty parts drag the window (and double-click zooms it); on macOS the
// window's own buttons sit in its top left corner (see windowChrome.ts).
import { Fragment, type ReactNode } from "react";
import { ChevronRight, PanelLeftClose, PanelLeftOpen, Search, Trash2 } from "lucide-react";
import type { PageSummary } from "./api.ts";
import { tip } from "./shortcuts.ts";

/** Marks an element as a handle for moving the window. Only the element itself, not its children. */
const drag = { "data-tauri-drag-region": "" };

function TitleBar({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={"titlebar" + (className ? ` ${className}` : "")} {...drag}>
      {children}
    </div>
  );
}

/** Over the sidebar: room for the window's buttons, then hiding the sidebar. */
export function SidebarTitleBar({ onHide }: { onHide: () => void }) {
  return (
    <TitleBar className="titlebar-sidebar">
      <div className="spacer" {...drag} />
      <button
        className="icon-button"
        title={tip("Hide the sidebar", "toggleSidebar")}
        aria-label="Hide the sidebar"
        onClick={onHide}
      >
        <PanelLeftClose size={16} />
      </button>
    </TitleBar>
  );
}

/**
 * Over the page: where it is in the page tree, and what can be done with it.
 * With the sidebar hidden it also has the buttons to show it and to search.
 */
export function PageTitleBar({
  trail,
  draftTitle,
  sidebarHidden,
  onShowSidebar,
  onSearch,
  onSelect,
  onDelete,
}: {
  /** The open page and its ancestors, outermost first; empty with no page open. */
  trail: PageSummary[];
  /** The open page's title as it's being typed, before it's saved. */
  draftTitle: string | null;
  sidebarHidden: boolean;
  onShowSidebar: () => void;
  onSearch: () => void;
  onSelect: (id: string) => void;
  onDelete?: () => void;
}) {
  return (
    <TitleBar className="titlebar-page">
      {sidebarHidden && (
        <>
          <button
            className="icon-button"
            title={tip("Show the sidebar", "toggleSidebar")}
            aria-label="Show the sidebar"
            onClick={onShowSidebar}
          >
            <PanelLeftOpen size={16} />
          </button>
          <button className="icon-button" title={tip("Search", "search")} aria-label="Search" onClick={onSearch}>
            <Search size={15} />
          </button>
        </>
      )}
      <nav className="breadcrumb" aria-label="Page location" {...drag}>
        {trail.map((page, i) => {
          const last = i === trail.length - 1;
          const title = (last && draftTitle !== null ? draftTitle : page.title) || "Untitled";
          return (
            <Fragment key={page.id}>
              {i > 0 && <ChevronRight size={13} className="breadcrumb-sep" aria-hidden {...drag} />}
              <button
                className={"breadcrumb-item" + (last ? " current" : "")}
                aria-current={last ? "page" : undefined}
                title={title}
                onClick={() => onSelect(page.id)}
              >
                {title}
              </button>
            </Fragment>
          );
        })}
      </nav>
      <div className="spacer" {...drag} />
      {onDelete && (
        <button className="icon-button danger" title={tip("Delete page", "deletePage")} aria-label="Delete page" onClick={onDelete}>
          <Trash2 size={15} />
        </button>
      )}
    </TitleBar>
  );
}
