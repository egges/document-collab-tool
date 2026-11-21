// Gives code blocks a language by themselves, as Notion does: when you paste
// into a block, or finish typing in one and move on, it detects the language
// and writes it into the fence (```python). Only blocks edited in this
// session are touched, so opening a page never changes it, and a language
// someone picked by hand is never overridden.
import type { Node } from "@milkdown/kit/prose/model";
import { type EditorState, Plugin, PluginKey, type Transaction } from "@milkdown/kit/prose/state";
import { detected } from "./highlight.ts";

/**
 * Blocks that get their language detected, by position, with the text it
 * was last detected from (null: not yet).
 */
type Watched = Map<number, string | null>;

type Meta = { watch: number } | { unwatch: number } | { detectedFrom: [pos: number, text: string][] };

export const autoLanguageKey = new PluginKey<Watched>("codeAutoLanguage");

const isCode = (node: Node | null | undefined): node is Node => node?.type.name === "code_block";

/** Marks the code block at `pos` as having its language chosen by hand (or, with `auto`, as detected again). */
export function chooseLanguage(tr: Transaction, pos: number, language: string): Transaction {
  tr.setNodeAttribute(pos, "language", language);
  return tr.setMeta(autoLanguageKey, language ? { unwatch: pos } : { watch: pos });
}

/** Code blocks that a transaction changed the text of. */
function editedBlocks(tr: Transaction, doc: Node): number[] {
  const found = new Set<number>();
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const from = rest.map(newStart, -1);
      const to = Math.min(rest.map(newEnd, 1), doc.content.size);
      doc.nodesBetween(from, to, (node, pos) => {
        if (isCode(node)) found.add(pos);
        return !node.isTextblock;
      });
    });
  });
  return [...found];
}

export function autoLanguagePlugin(): Plugin<Watched> {
  return new Plugin<Watched>({
    key: autoLanguageKey,
    state: {
      init: () => new Map(),
      apply(tr, watched, _old, state) {
        let next: Watched = watched;
        if (tr.docChanged) {
          next = new Map();
          for (const [pos, text] of watched) {
            const mapped = tr.mapping.mapResult(pos, 1);
            if (!mapped.deleted) next.set(mapped.pos, text);
          }
          for (const pos of editedBlocks(tr, state.doc)) {
            const node = state.doc.nodeAt(pos);
            // A block with a language is only re-detected if we gave it that language.
            if (isCode(node) && !node.attrs.language && !next.has(pos)) next.set(pos, null);
          }
        }
        const meta = tr.getMeta(autoLanguageKey) as Meta | undefined;
        if (meta) {
          if (next === watched) next = new Map(watched);
          if ("watch" in meta) next.set(meta.watch, null);
          else if ("unwatch" in meta) next.delete(meta.unwatch);
          else for (const [pos, text] of meta.detectedFrom) next.set(pos, text);
        }
        return next;
      },
    },
    appendTransaction(trs, _old, state) {
      const watched = autoLanguageKey.getState(state);
      if (!watched?.size) return null;
      const pasted = trs.some((tr) => tr.getMeta("paste") || tr.getMeta("uiEvent") === "paste");
      return detectWhereDone(state, watched, pasted);
    },
  });
}

/**
 * Detects the language of watched blocks the cursor isn't in (and of the one
 * it is in, right after a paste).
 */
function detectWhereDone(state: EditorState, watched: Watched, pasted: boolean): Transaction | null {
  const { from, to } = state.selection;
  const tr = state.tr;
  const detectedFrom: [number, string][] = [];
  for (const [pos, last] of watched) {
    const node = state.doc.nodeAt(pos);
    if (!isCode(node)) continue;
    const inside = from > pos && to < pos + node.nodeSize;
    if (inside && !pasted) continue;
    const text = node.textContent;
    if (text === last) continue;
    detectedFrom.push([pos, text]);
    const language = detected(text);
    if (language && language !== node.attrs.language) tr.setNodeAttribute(pos, "language", language);
  }
  if (!detectedFrom.length) return null;
  // History groups an appended transaction with the edit before it, so one
  // undo takes back the typing and the language together.
  return tr.setMeta(autoLanguageKey, { detectedFrom });
}
