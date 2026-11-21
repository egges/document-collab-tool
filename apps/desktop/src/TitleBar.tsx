// The window's title bar, drawn by the app: one strip across the top of the
// sidebar and one across the page, the same height, so they read as one bar.
// Empty parts move the window and double-clicking them zooms it (see
// windowChrome.ts); on macOS the window's own buttons sit in its top left
// corner. The button that shows and hides the sidebar stays in one place,
// right of those, whether the sidebar is open or not.
import { Fragment, type ReactNode } from "react";
import { ChevronRight, PanelLeftClose, PanelLeftOpen, Search, Trash2 } from "lucide-react";
import type { PageSummary } from "./api.ts";
import { tip } from "./shortcuts.ts";
import { WINDOW_DRAG } from "./windowChrome.ts";

function TitleBar({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <div className={"titlebar" + (className ? ` ${className}` : "")} {...WINDOW_DRAG}>
      {children}
    </div>
  );
}

/** Over the sidebar. Empty: the sidebar button floats over its left end. */
export function SidebarTitleBar() {
  return <TitleBar className="titlebar-sidebar" />;
}

/** Shows or hides the sidebar, from the same spot in either state. */
export function SidebarToggle({ hidden, onToggle }: { hidden: boolean; onToggle: () => void }) {
  const label = hidden ? "Show the sidebar" : "Hide the sidebar";
  return (
    <button className="icon-button sidebar-toggle" title={tip(label, "toggleSidebar")} aria-label={label} onClick={onToggle}>
      {hidden ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
    </button>
  );
}

/**
 * Over the page: where it is in the page tree, and what can be done with it.
 * With the sidebar hidden it also has a search button.
 */
export function PageTitleBar({
  trail,
  draftTitle,
  sidebarHidden,
  onSearch,
  onSelect,
  onDelete,
}: {
  /** The open page and its ancestors, outermost first; empty with no page open. */
  trail: PageSummary[];
  /** The open page's title as it's being typed, before it's saved. */
  draftTitle: string | null;
  sidebarHidden: boolean;
  onSearch: () => void;
  onSelect: (id: string) => void;
  onDelete?: () => void;
}) {
  return (
    <TitleBar className="titlebar-page">
      {sidebarHidden && (
        <button className="icon-button" title={tip("Search", "search")} aria-label="Search" onClick={onSearch}>
          <Search size={15} />
        </button>
      )}
      <nav className="breadcrumb" aria-label="Page location">
        {trail.map((page, i) => {
          const last = i === trail.length - 1;
          const title = (last && draftTitle !== null ? draftTitle : page.title) || "Untitled";
          return (
            <Fragment key={page.id}>
              {i > 0 && <ChevronRight size={13} className="breadcrumb-sep" aria-hidden />}
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
      <div className="spacer" />
      {onDelete && (
        <button className="icon-button danger" title={tip("Delete page", "deletePage")} aria-label="Delete page" onClick={onDelete}>
          <Trash2 size={15} />
        </button>
      )}
    </TitleBar>
  );
}
