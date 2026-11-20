// The safety check run before every save: would writing this Markdown lose
// anything the user can see?
import type { Node } from "@milkdown/kit/prose/model";

/**
 * A flat description of what a document shows: the text of every text block
 * (paragraph, heading, code block, ...) including inline atoms such as images
 * and inline HTML, and every block atom such as a rule or a raw HTML block, in
 * order. Formatting is left out on purpose: the check is about content going
 * missing, not about style.
 */
export function visibleContent(doc: Node): string[] {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.isTextblock) {
      const text = node.textBetween(0, node.content.size, "\n", describeAtom);
      out.push(`${node.type.name}: ${text}`);
      return false;
    }
    if (node.isAtom) {
      out.push(describeAtom(node));
      return false;
    }
    return true;
  });
  return out;
}

function describeAtom(node: Node): string {
  return `[${node.type.name} ${JSON.stringify(node.attrs)}]`;
}

/**
 * Compares what the editor shows (`expected`) with what the saved Markdown
 * would show when read back (`actual`). Returns a description of the first
 * difference, or null if nothing is lost.
 */
export function findLostContent(expected: Node, actual: Node): string | null {
  const a = visibleContent(expected);
  const b = visibleContent(actual);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) {
      return `block ${i + 1}: expected ${JSON.stringify(a[i] ?? "(nothing)")}, ` +
        `saved file would show ${JSON.stringify(b[i] ?? "(nothing)")}`;
    }
  }
  return null;
}

/** Thrown by `save()` when writing the page would lose visible content. */
export class SaveRefusedError extends Error {
  constructor(readonly detail: string) {
    super(`Refusing to save: the saved page would lose content (${detail})`);
    this.name = "SaveRefusedError";
  }
}
