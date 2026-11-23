import { useEffect, useMemo, useRef, useState } from "react";
import { FilePlus, FileText, Search as SearchIcon, TextSearch } from "lucide-react";
import { type PageSummary, type TextMatch, api } from "./api.ts";
import { log } from "./devlog.ts";
import { type SearchAction, type SearchResult, highlight, searchSections } from "./search.ts";

const ICONS = { page: FileText, text: TextSearch, create: FilePlus };

/** ⌘K: search page titles and page text; Enter opens the result, or creates a page with the typed title. */
export function Search({
  pages,
  onAction,
  onClose,
}: {
  pages: PageSummary[];
  onAction: (action: SearchAction) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  // By key, so the highlighted result stays put when text matches arrive.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const text = useTextSearch(query);
  const sections = useMemo(() => searchSections(pages, query, text), [pages, query, text]);
  const results = sections.flatMap((s) => s.results);
  const active = Math.max(0, results.findIndex((r) => r.key === activeKey));
  const setActive = (i: number) => setActiveKey(results[i]?.key ?? null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    list.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (result: SearchResult | undefined) => result && onAction(result.action);

  let index = 0;
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog search" role="dialog" aria-label="Search" onMouseDown={(e) => e.stopPropagation()}>
        <div className="search-field">
        <SearchIcon size={17} className="search-field-icon" aria-hidden />
        <input
          autoFocus
          className="search-input"
          placeholder="Search pages, or type a title for a new page"
          value={query}
          role="combobox"
          aria-expanded
          aria-controls="search-results"
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveKey(null);
          }}
          onKeyDown={(e) => {
            const n = results.length;
            if (e.key === "ArrowDown") setActive(n ? (active + 1) % n : 0);
            else if (e.key === "ArrowUp") setActive(n ? (active - 1 + n) % n : 0);
            else if (e.key === "Enter") choose(results[active]);
            else if (e.key === "Escape") onClose();
            else return;
            e.preventDefault();
          }}
        />
        </div>
        <ul className="search-list" id="search-results" role="listbox" ref={list}>
          {sections.map((section) => (
            <li key={section.label} role="presentation">
              <div className="search-section">{section.label}</div>
              <ul role="group" aria-label={section.label}>
                {section.results.map((result) => {
                  const i = index++;
                  return (
                    <ResultRow
                      key={result.key}
                      result={result}
                      query={query}
                      active={i === active}
                      onHover={() => setActive(i)}
                      onChoose={() => choose(result)}
                    />
                  );
                })}
              </ul>
            </li>
          ))}
          {results.length === 0 && <li className="search-empty">No pages yet. Type a title to create one.</li>}
        </ul>
      </div>
    </div>
  );
}

function ResultRow({
  result,
  query,
  active,
  onHover,
  onChoose,
}: {
  result: SearchResult;
  query: string;
  active: boolean;
  onHover: () => void;
  onChoose: () => void;
}) {
  const Icon = ICONS[result.icon];
  const parts = result.icon === "page" ? highlight(result.title, query) : null;
  return (
    <li
      role="option"
      aria-selected={active}
      className={"search-result" + (active ? " active" : "")}
      onMouseMove={onHover}
      onClick={onChoose}
    >
      <Icon size={14} aria-hidden />
      <div className="search-result-text">
        <div className="search-result-title">
          <span className={result.title === "Untitled" ? "untitled" : ""}>
            {parts ? (
              <>
                {parts[0]}
                <mark>{parts[1]}</mark>
                {parts[2]}
              </>
            ) : (
              result.title
            )}
          </span>
          {result.detail && <span className="search-detail">{result.detail}</span>}
        </div>
        {result.snippet && (
          <div className="search-snippet">
            {result.snippet.before}
            <mark>{result.snippet.matched}</mark>
            {result.snippet.after}
          </div>
        )}
      </div>
    </li>
  );
}

/** Text matches for `query`, shortly after typing stops. Stale answers are dropped. */
function useTextSearch(query: string): TextMatch[] {
  const [matches, setMatches] = useState<{ query: string; matches: TextMatch[] }>({ query: "", matches: [] });
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    let current = true;
    const timer = setTimeout(() => {
      api
        .searchText(q)
        .then((found) => current && setMatches({ query: q, matches: found }))
        .catch((e) => log("warn", "ui", `Text search failed: ${String(e)}`));
    }, 120);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query]);
  return matches.query === query.trim() ? matches.matches : [];
}
