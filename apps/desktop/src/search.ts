// The search palette's results (⌘K), grouped in sections. Each kind of thing
// that can be found (pages by title, text in pages, and later databases,
// rows, …) adds a section here; the palette only shows them.
import type { PageSummary, TextMatch } from "./api.ts";
import { ancestry, search as searchTitles } from "./pageTree.ts";

export type SearchAction =
  | { kind: "openPage"; id: string; reveal?: string }
  | { kind: "createPage"; title: string };

export interface SearchResult {
  key: string;
  icon: "page" | "text" | "create";
  title: string;
  /** Where it is, such as the parent pages. */
  detail?: string;
  /** For text matches: the line, split around the match. */
  snippet?: { before: string; matched: string; after: string };
  action: SearchAction;
}

export interface SearchSection {
  label: string;
  results: SearchResult[];
}

const MAX_TITLES = 30;

/**
 * Sections for `query`. `text` is the result of searching page text for the
 * same query (empty until it arrives).
 */
export function searchSections(pages: PageSummary[], query: string, text: TextMatch[]): SearchSection[] {
  const q = query.trim();
  const byId = new Map(pages.map((p) => [p.id, p]));
  const pathOf = (id: string) => ancestry(pages, id).join(" / ") || undefined;
  const sections: SearchSection[] = [];

  const titled = searchTitles(pages, q).slice(0, MAX_TITLES);
  if (titled.length) {
    sections.push({
      label: q ? "Pages" : "All pages",
      results: titled.map((page) => ({
        key: `page:${page.id}`,
        icon: "page",
        title: page.title || "Untitled",
        detail: pathOf(page.id),
        action: { kind: "openPage", id: page.id },
      })),
    });
  }

  const inText = q ? text.filter((m) => byId.has(m.page)) : [];
  if (inText.length) {
    sections.push({
      label: "In pages",
      results: inText.map((m) => {
        const page = byId.get(m.page)!;
        return {
          key: `text:${m.page}`,
          icon: "text",
          title: page.title || "Untitled",
          detail: m.count > 1 ? `${m.count} matches` : undefined,
          snippet: { before: m.before, matched: m.matched, after: m.after },
          action: { kind: "openPage", id: m.page, reveal: q },
        };
      }),
    });
  }

  if (q && !pages.some((p) => p.title.toLowerCase() === q.toLowerCase())) {
    sections.push({
      label: "Create",
      results: [{ key: "create", icon: "create", title: `New page “${q}”`, action: { kind: "createPage", title: q } }],
    });
  }
  return sections;
}

/** Splits `text` around the first place `query` appears, ignoring case, to highlight it. */
export function highlight(text: string, query: string): [string, string, string] | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const at = text.toLowerCase().indexOf(q);
  // Lowercasing can change the length (rare); then don't highlight.
  if (at < 0 || text.toLowerCase().length !== text.length) return null;
  return [text.slice(0, at), text.slice(at, at + q.length), text.slice(at + q.length)];
}
