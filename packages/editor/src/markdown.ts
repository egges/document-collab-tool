// How pages are read from and written to Markdown. Everything that decides
// the bytes in page.md lives here, so it's easy to see and to test.
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { Fragment, type Node } from "@milkdown/kit/prose/model";
import { remarkGFMPlugin } from "@milkdown/kit/preset/gfm";

/**
 * Our house style for remark's Markdown output. Without it Milkdown writes
 * `*` bullets and `***` rules, and pads table columns, so editing one cell
 * rewrites every row of the table.
 */
export function configureHouseStyle(ctx: Ctx): void {
  ctx.update(remarkStringifyOptionsCtx, (options) => ({
    ...options,
    bullet: "-" as const,
    rule: "-" as const,
  }));
  ctx.set(remarkGFMPlugin.options.key, { tablePipeAlign: false });
}

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

/**
 * Splits YAML front matter off the top of a page. The editor can't represent
 * it (it would become a rule and a heading), so it's kept aside unchanged and
 * put back on save. Our own pages keep metadata in meta.json; this protects
 * pages imported from other tools until the importer moves it there.
 */
export function splitFrontMatter(markdown: string): { frontMatter: string; body: string } {
  const match = markdown.match(FRONT_MATTER);
  if (!match) return { frontMatter: "", body: markdown };
  return { frontMatter: match[0], body: markdown.slice(match[0].length) };
}

/** The final bytes for page.md: front matter, then the body ending in exactly one newline. */
export function joinPage(frontMatter: string, body: string): string {
  const trimmed = body.replace(/\s+$/, "");
  const text = trimmed === "" ? "" : `${trimmed}\n`;
  return frontMatter + (frontMatter && text ? "\n" : "") + text;
}

const isEmptyParagraph = (node: Node) => node.type.name === "paragraph" && node.content.size === 0;

/**
 * Removes empty paragraphs (the blank lines left by pressing Enter twice)
 * from the top level of a page and from quotes. Markdown can't store them:
 * Milkdown would write each one as a `<br />` line.
 */
export function withoutEmptyParagraphs(node: Node): Node {
  let changed = false;
  const children: Node[] = [];
  node.forEach((child) => {
    if (isEmptyParagraph(child)) {
      changed = true;
      return;
    }
    const cleaned = child.type.name === "blockquote" ? withoutEmptyParagraphs(child) : child;
    if (cleaned !== child) changed = true;
    // A quote left with nothing in it goes too.
    if (cleaned.type.name === "blockquote" && cleaned.childCount === 0) return;
    children.push(cleaned);
  });
  return changed ? node.copy(Fragment.fromArray(children)) : node;
}
