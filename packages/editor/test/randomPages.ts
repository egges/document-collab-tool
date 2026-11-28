// Random pages for property tests: every kind of block, nested in list items
// and toggles at any depth. fast-check shrinks a failing page to the smallest one that
// still fails, so a failure reads as a short Markdown page.
import fc from "fast-check";
import type { Node } from "@milkdown/kit/prose/model";
import type { Block } from "../src/index.ts";

const KINDS = ["paragraph", "heading", "code", "quote", "image", "table", "rule", "bullet", "ordered", "task", "toggle"] as const;
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
    case "toggle": return ["<details>", done ? `<summary>Toggle ${text}</summary>` : `<summary><h3>Toggle ${text}</h3></summary>`];
  }
}

/** How far the blocks nested in an item of this kind are indented. */
const nestIndent = (kind: Kind) => (kind === "ordered" ? "   " : "  ");

/**
 * A page of 1 to `max` blocks. Each block asks for a nesting depth and gets
 * at most that, as deep as the open list items and toggles allow.
 */
export const randomPage = (max = 8) =>
  fc
    .array(fc.record({ kind: fc.constantFrom(...KINDS), depth: fc.nat(3), done: fc.boolean() }), { minLength: 1, maxLength: max })
    .map((specs) => {
      const lines: string[] = [];
      // The open items and toggles the previous block is nested in: how far
      // what's nested in each is indented, and the line that closes a toggle.
      const open: { indent: string; close?: string }[] = [];
      const indent = () => open.map((level) => level.indent).join("");
      let prev: Kind | "closed" | null = null;
      const closeTo = (depth: number) => {
        while (open.length > depth) {
          const { close } = open.pop()!;
          if (!close) continue;
          lines.push("", indent() + close);
          prev = "closed";
        }
      };
      specs.forEach(({ kind, depth: wanted, done }, i) => {
        closeTo(Math.min(wanted, open.length));
        // Items follow each other without a blank line, so lists are tight; anything else needs one.
        if (prev && !(prev !== "closed" && isItem(prev) && isItem(kind))) lines.push("");
        for (const line of write(kind, `b${i + 1}`, done)) lines.push(indent() + line);
        if (isItem(kind)) open.push({ indent: nestIndent(kind) });
        if (kind === "toggle") open.push({ indent: "", close: "</details>" });
        prev = kind;
      });
      closeTo(0);
      return `${lines.join("\n")}\n`;
    });

const isContainer = (node: Node | null | undefined) => node?.type.name === "list_item" || node?.type.name === "toggle";

/** Every block of the page, in the order their lines are on screen. */
export function allBlocks(doc: Node): Block[] {
  const blocks: Block[] = [];
  doc.descendants((node, pos, parent, index) => {
    const isBlock = parent === doc || (isContainer(parent) && index > 0);
    if (isBlock) blocks.push({ pos, node });
    // Only list items and toggles hold blocks; their first child is their own line.
    return isContainer(node);
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
      } else if (child.type.name === "toggle" && (node.type.name === "doc" || index > 0)) {
        out.push(`${pad}toggle ${child.firstChild!.toString()}`);
        visit(child, depth + 1);
      } else if (node.type.name === "doc" || index > 0) {
        out.push(pad + child.toString());
      }
    });
  };
  visit(doc, 0);
  return out;
}
