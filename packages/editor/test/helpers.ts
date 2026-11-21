import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { diffLines } from "diff";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import type { EditorView } from "@milkdown/kit/prose/view";
import { splitFrontMatter } from "../src/markdown.ts";

const PAGES = join(import.meta.dirname, "pages");

/** The example pages: realistic content written by people, other tools and AI agents. */
export const pages = readdirSync(PAGES)
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((name) => ({ name, markdown: readFileSync(join(PAGES, name), "utf8") }));

/**
 * The page rendered by a reference CommonMark + GFM parser (micromark), with
 * whitespace between tags normalized. Two files that render the same differ
 * only in Markdown spelling.
 */
export function render(markdown: string): string {
  const { frontMatter, body } = splitFrontMatter(markdown);
  const html = micromark(body, {
    allowDangerousHtml: true,
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
  });
  return frontMatter + html.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
}

/** Number of lines added plus removed between two files. */
export function changedLines(a: string, b: string): number {
  let n = 0;
  for (const part of diffLines(a, b)) if (part.added || part.removed) n += part.count ?? 0;
  return n;
}

const WORD = /\b[a-z]{5,}\b/;

/**
 * Replaces the first long word in a plain paragraph with "EDITED", through a
 * normal editor transaction, as if the user typed it. Returns false if the
 * page has no such word.
 */
export function editOneWord(view: EditorView): boolean {
  let range: { from: number; to: number } | null = null;
  view.state.doc.descendants((node, pos, parent) => {
    if (range) return false;
    if (node.isText && parent?.type.name === "paragraph" &&
        !node.marks.some((m) => m.type.name === "inlineCode")) {
      const match = node.text!.match(WORD);
      if (match) range = { from: pos + match.index!, to: pos + match.index! + match[0].length };
    }
    return true;
  });
  if (!range) return false;
  const { from, to } = range;
  view.dispatch(view.state.tr.insertText("EDITED", from, to));
  return true;
}
