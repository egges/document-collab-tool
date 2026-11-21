// What clicking a link in a page does: open another page here, or the
// address in the browser (or mail app).
import type { PageSummary } from "./api.ts";

export type LinkTarget = { kind: "page"; id: string } | { kind: "external"; url: string } | { kind: "none" };

/**
 * Where a link goes. A link to another page is a relative path containing
 * its id (as `../<id>/page.md` from page.md, which is what other Markdown
 * tools and AI agents write). An address without a scheme, such as
 * "example.com", gets https://.
 */
export function linkTarget(href: string, pages: PageSummary[]): LinkTarget {
  const link = href.trim();
  if (!link || link.startsWith("#")) return { kind: "none" };
  if (/^(https?|mailto):/i.test(link)) return { kind: "external", url: link };
  if (/^[a-z][a-z\d+.-]*:/i.test(link)) return { kind: "none" }; // file:, javascript:, …: not ours to open
  if (!link.startsWith("/") && !link.startsWith(".")) {
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(link) && !/\.md([?#]|$)/i.test(link)) {
      return { kind: "external", url: `https://${link}` };
    }
  }
  const segments = link.split(/[?#]/)[0].split("/");
  const ids = new Set(pages.map((p) => p.id));
  const id = segments.find((s) => ids.has(s));
  return id ? { kind: "page", id } : { kind: "none" };
}
