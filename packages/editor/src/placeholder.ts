// Hints in empty blocks, as in Notion: the empty block with the cursor says
// what it is and how to get the block menu, and a page with nothing in it
// says so even before it's clicked. Only decorations: nothing is saved.
import { type EditorState, Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";

export const WRITE_HINT = "Write something, or type “/” for commands";

/** The empty block to hint in (its position) and what to say, or null. */
export function placeholderAt(state: EditorState, focused: boolean): { pos: number; text: string } | null {
  const { doc, selection } = state;
  // An empty page: one empty paragraph, focused or not.
  const only = doc.childCount === 1 ? doc.firstChild! : null;
  if (only?.type.name === "paragraph" && only.content.size === 0 && (!focused || selection.empty)) {
    return { pos: 0, text: WRITE_HINT };
  }
  if (!focused || !selection.empty) return null;
  const { $from } = selection;
  const block = $from.parent;
  if (!block.isTextblock || block.content.size > 0 || block.type.spec.code) return null;
  const pos = $from.before();
  if (block.type.name === "heading") {
    const inToggle = $from.node(-1).type.name === "toggle" && $from.index(-1) === 0;
    return { pos, text: `${inToggle ? "Toggle heading" : "Heading"} ${block.attrs.level}` };
  }
  if (block.type.name !== "paragraph") return null;
  const container = $from.depth > 1 ? $from.node($from.depth - 1) : null;
  switch (container?.type.name) {
    case undefined:
      return { pos, text: WRITE_HINT };
    case "toggle":
      return { pos, text: $from.index($from.depth - 1) > 0 ? WRITE_HINT : "Toggle" };
    case "list_item":
      // Blocks nested in an item get the usual hint; the item's own line says what it is.
      if ($from.index($from.depth - 1) > 0) return { pos, text: WRITE_HINT };
      return { pos, text: container.attrs.checked != null ? "To-do" : "List" };
    case "blockquote":
      return { pos, text: "Quote" };
    default:
      return null; // table cells and anything else: no hint
  }
}

const key = new PluginKey<boolean>("page-placeholder");

export function placeholderPlugin(): Plugin {
  return new Plugin({
    key,
    // Whether the editor has focus; the hint follows the cursor only then.
    state: {
      init: () => false,
      apply: (tr, focused) => (tr.getMeta(key) as boolean | undefined) ?? focused,
    },
    props: {
      decorations(state) {
        const at = placeholderAt(state, key.getState(state)!);
        if (!at) return null;
        const node = state.doc.nodeAt(at.pos)!;
        return DecorationSet.create(state.doc, [
          Decoration.node(at.pos, at.pos + node.nodeSize, { class: "page-placeholder", "data-placeholder": at.text }),
        ]);
      },
      handleDOMEvents: {
        focus: (view) => {
          view.dispatch(view.state.tr.setMeta(key, true));
          return false;
        },
        blur: (view) => {
          view.dispatch(view.state.tr.setMeta(key, false));
          return false;
        },
      },
    },
  });
}
