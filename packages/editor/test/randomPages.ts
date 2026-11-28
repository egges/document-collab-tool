// Random pages for property tests: every kind of block, nested in list items
// at any depth. fast-check shrinks a failing page to the smallest one that
// still fails, so a failure reads as a short Markdown page.
import fc from "fast-check";
import type { Node } from "@milkdown/kit/prose/model";
import type { Block } from "../src/index.ts";

const KINDS = ["paragraph", "heading", "code", "quote", "image", "table", "rule", "bullet", "ordered", "task"] as const;
type Kind = (typeof KINDS)[number];

const isItem = (kind: Kind) => kind === "bullet" || kind === "ordered" || kind === "task";

/** One block, written in Markdown with `text` as its content (unique per block). */
function write(kind: Kind, text: string, done: boolean): string[] {
  switch (kind) {
    case "paragraph": return [`Text ${text}.`];
    case "heading": return [`## Heading ${text}`];
    case "code": return ["```", `code ${text}`, "```"];
    case "quote": return [`> Quote ${text}.`];
    case "image": return [`![${text}](${text}.png)`];
    case "table": return [`| ${text} | b |`, "| --- | --- |", "| c | d |"];
    case "rule": return ["***"];
    case "bullet": return [`- Item ${text}`];
    case "ordered": return [`1. Item ${text}`];
    case "task": return [`- [${done ? "x" : " "}] Item ${text}`];
  }
}

/** How far the blocks nested in an item of this kind are indented. */
const nestIndent = (kind: Kind) => (kind === "ordered" ? "   " : "  ");

/**
 * A page of 1 to `max` blocks. Each block asks for a nesting depth and gets
 * at most that, as deep as the open list items allow.
 */
export const randomPage = (max = 8) =>
  fc
    .array(fc.record({ kind: fc.constantFrom(...KINDS), depth: fc.nat(3), done: fc.boolean() }), { minLength: 1, maxLength: max })
    .map((specs) => {
      const lines: string[] = [];
      // How far the blocks nested in each open item are indented: the
      // previous block and the items it's nested in.
      const indents: string[] = [];
      let prev: Kind | null = null;
      specs.forEach(({ kind, depth: wanted, done }, i) => {
        // Close the items deeper than this block.
        indents.length = Math.min(wanted, indents.length);
        // Items follow each other without a blank line, so lists are tight; anything else needs one.
        if (prev && !(isItem(prev) && isItem(kind))) lines.push("");
        for (const line of write(kind, `b${i + 1}`, done)) lines.push(indents.join("") + line);
        if (isItem(kind)) indents.push(nestIndent(kind));
        prev = kind;
      });
      return `${lines.join("\n")}\n`;
    });

/** Every block of the page, in the order their lines are on screen. */
export function allBlocks(doc: Node): Block[] {
  const blocks: Block[] = [];
  doc.descendants((node, pos, parent, index) => {
    const isBlock = parent === doc || (parent?.type.name === "list_item" && index > 0);
    if (isBlock) blocks.push({ pos, node });
    // Only list items hold blocks; the first child of an item is its own line.
    return node.type.name === "list_item";
  });
  return blocks;
}

/**
 * What the page shows, block by block, with nesting: what saving and opening
 * again must keep. Leaves out how the Markdown is spelled (loose or tight
 * lists, for example).
 */
export function outline(doc: Node): string[] {
  const out: string[] = [];
  const visit = (node: Node, depth: number) => {
    node.forEach((child, _offset, index) => {
      const pad = "  ".repeat(depth);
      if (child.type.name === "list_item") {
        const { listType, checked } = child.attrs;
        out.push(`${pad}${listType}${checked == null ? "" : checked ? " [x]" : " [ ]"} ${child.firstChild!.toString()}`);
        visit(child, depth + 1);
      } else if (node.type.name === "doc" || index > 0) {
        out.push(pad + child.toString());
      }
    });
  };
  visit(doc, 0);
  return out;
}
