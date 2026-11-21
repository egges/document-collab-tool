// Syntax highlighting for code blocks, as decorations: the document (and so
// the Markdown) never changes, only how the text is drawn.
import type { Node } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { detectLanguage } from "./detect.ts";
import { findLanguage, lowlight } from "./languages.ts";

/** Text longer than this is drawn plain: highlighting it on every keystroke would lag. */
const MAX_LENGTH = 100_000;

interface Token {
  from: number;
  to: number;
  className: string;
}

/** What a code block is shown as: its own language, or the detected one when it has none. */
export function shownLanguage(node: Node): string | null {
  const name = node.attrs.language as string;
  if (name) return findLanguage(name)?.id ?? null;
  return detected(node.textContent);
}

const detections = new Map<string, string | null>();

/** `detectLanguage`, remembered for the last few hundred texts. */
export function detected(text: string): string | null {
  if (detections.has(text)) return detections.get(text)!;
  const result = detectLanguage(text);
  if (detections.size > 300) detections.clear();
  detections.set(text, result);
  return result;
}

// Nodes never change, so a block that wasn't edited keeps its tokens.
const tokenCache = new WeakMap<Node, Token[]>();

function tokensOf(node: Node): Token[] {
  const cached = tokenCache.get(node);
  if (cached) return cached;
  const tokens: Token[] = [];
  const text = node.textContent;
  const grammar = findLanguage(shownLanguage(node) ?? "")?.grammar;
  if (grammar && text.length <= MAX_LENGTH) {
    const tree = lowlight.highlight(grammar, text);
    let offset = 0;
    const walk = (nodes: typeof tree.children, classes: string[]) => {
      for (const child of nodes) {
        if (child.type === "text") {
          const end = offset + child.value.length;
          if (classes.length) tokens.push({ from: offset, to: end, className: classes.join(" ") });
          offset = end;
        } else if (child.type === "element") {
          const own = (child.properties?.className as string[] | undefined) ?? [];
          walk(child.children, [...classes, ...own]);
        }
      }
    };
    walk(tree.children, []);
  }
  tokenCache.set(node, tokens);
  return tokens;
}

function decorate(doc: Node): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "code_block") return true;
    for (const token of tokensOf(node)) {
      decorations.push(Decoration.inline(pos + 1 + token.from, pos + 1 + token.to, { class: token.className }));
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

export const highlightKey = new PluginKey<DecorationSet>("codeHighlight");

export function highlightPlugin(): Plugin<DecorationSet> {
  return new Plugin({
    key: highlightKey,
    state: {
      init: (_config, state) => decorate(state.doc),
      apply: (tr, set) => (tr.docChanged ? decorate(tr.doc) : set),
    },
    props: {
      decorations: (state) => highlightKey.getState(state),
    },
  });
}
