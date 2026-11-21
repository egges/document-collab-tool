// The page tree as the sidebar shows it, for the sidebar, previous/next page
// and the page switcher.
import type { PageSummary } from "./api.ts";

export type Children = Map<string | null, PageSummary[]>;

/** Pages by parent, in list order (the Rust side sorts by title). */
export function childrenOf(pages: PageSummary[]): Children {
  const map: Children = new Map();
  for (const page of pages) {
    const list = map.get(page.parent) ?? [];
    list.push(page);
    map.set(page.parent, list);
  }
  return map;
}

/** Every page, top to bottom as in the sidebar with everything expanded. */
export function displayOrder(pages: PageSummary[]): PageSummary[] {
  const children = childrenOf(pages);
  const out: PageSummary[] = [];
  const visit = (parent: string | null) => {
    for (const page of children.get(parent) ?? []) {
      out.push(page);
      visit(page.id);
    }
  };
  visit(null);
  return out;
}

/** Titles of a page's ancestors, outermost first. */
export function ancestry(pages: PageSummary[], id: string): string[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const titles: string[] = [];
  let current = byId.get(id)?.parent;
  while (current && titles.length < 20) {
    const page = byId.get(current);
    if (!page) break;
    titles.unshift(page.title || "Untitled");
    current = page.parent;
  }
  return titles;
}

/** A page and its ancestors, outermost first: the breadcrumb in the title bar. */
export function trail(pages: PageSummary[], id: string): PageSummary[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const out: PageSummary[] = [];
  for (let page = byId.get(id); page && out.length < 20; page = page.parent ? byId.get(page.parent) : undefined) {
    out.unshift(page);
  }
  return out;
}

/** Pages matching a search, best first: title starts with it, then a word does, then it appears anywhere. */
export function search(pages: PageSummary[], query: string): PageSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return displayOrder(pages);
  const scored: [number, PageSummary][] = [];
  for (const page of displayOrder(pages)) {
    const title = (page.title || "Untitled").toLowerCase();
    const score = title.startsWith(q) ? 0 : title.split(/\s+/).some((w) => w.startsWith(q)) ? 1 : title.includes(q) ? 2 : -1;
    if (score >= 0) scored.push([score, page]);
  }
  return scored.sort((a, b) => a[0] - b[0]).map(([, page]) => page);
}
