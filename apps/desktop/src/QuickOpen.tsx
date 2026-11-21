import { useMemo, useState } from "react";
import { FilePlus, FileText } from "lucide-react";
import type { PageSummary } from "./api.ts";
import { ancestry, search } from "./pageTree.ts";

/** ⌘K: type to find a page, Enter to open it, or create one with that title. */
export function QuickOpen({
  pages,
  onOpen,
  onCreate,
  onClose,
}: {
  pages: PageSummary[];
  onOpen: (id: string) => void;
  onCreate: (title: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => search(pages, query).slice(0, 50), [pages, query]);
  const title = query.trim();
  const canCreate = title !== "" && !results.some((p) => p.title.toLowerCase() === title.toLowerCase());
  const count = results.length + (canCreate ? 1 : 0);

  const choose = (index: number) => {
    if (index < results.length) onOpen(results[index].id);
    else if (canCreate) onCreate(title);
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog quick-open" role="dialog" aria-label="Go to page" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="quick-input"
          placeholder="Go to page, or type a new title"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive((a) => (count ? (a + 1) % count : 0));
            else if (e.key === "ArrowUp") setActive((a) => (count ? (a - 1 + count) % count : 0));
            else if (e.key === "Enter") choose(active);
            else if (e.key === "Escape") onClose();
            else return;
            e.preventDefault();
          }}
        />
        <ul className="quick-list" role="listbox">
          {results.map((page, i) => {
            const path = ancestry(pages, page.id);
            return (
              <li
                key={page.id}
                role="option"
                aria-selected={i === active}
                className={i === active ? "active" : ""}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(i)}
              >
                <FileText size={14} aria-hidden />
                <span className={page.title ? "" : "untitled"}>{page.title || "Untitled"}</span>
                {path.length > 0 && <span className="quick-path">{path.join(" / ")}</span>}
              </li>
            );
          })}
          {canCreate && (
            <li
              role="option"
              aria-selected={active === results.length}
              className={active === results.length ? "active" : ""}
              onMouseEnter={() => setActive(results.length)}
              onClick={() => choose(results.length)}
            >
              <FilePlus size={14} aria-hidden />
              <span>
                New page “{title}”
              </span>
            </li>
          )}
          {count === 0 && <li className="quick-empty">No pages yet. Type a title to create one.</li>}
        </ul>
      </div>
    </div>
  );
}
