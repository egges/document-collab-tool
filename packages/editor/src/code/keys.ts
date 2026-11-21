// Typing in code blocks: ``` starts one, Enter keeps the indentation, Tab
// indents, and there are ways out (⌘↩, ↓ on the last line, Backspace in an
// empty block).
import { exitCode, setBlockType } from "@milkdown/kit/prose/commands";
import { textblockTypeInputRule } from "@milkdown/kit/prose/inputrules";
import type { ResolvedPos } from "@milkdown/kit/prose/model";
import { type Command, type EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import { $inputRule, $useKeymap } from "@milkdown/kit/utils";

const INDENT = "  ";

/** Typing ``` at the start of a line turns it into a code block straight away. */
export const codeFenceInputRule = $inputRule((ctx) => textblockTypeInputRule(/^```$/, codeBlockSchema.type(ctx)));

/** The cursor (or selection) when it's inside one code block. */
function inCode(state: EditorState): ResolvedPos | null {
  const { $from, $to } = state.selection;
  return $from.parent.type.spec.code && $from.sameParent($to) ? $from : null;
}

/** Offsets in the block's text where the lines touched by the selection start. */
function lineStarts(state: EditorState, $from: ResolvedPos): number[] {
  const text = $from.parent.textContent;
  const from = $from.parentOffset;
  const to = state.selection.$to.parentOffset;
  const starts = [text.lastIndexOf("\n", from - 1) + 1];
  for (let i = text.indexOf("\n", from); i >= 0 && i < to; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** A new line with the same indentation as this one. */
const newlineKeepingIndent: Command = (state, dispatch) => {
  const $from = inCode(state);
  if (!$from) return false;
  const text = $from.parent.textContent;
  const offset = $from.parentOffset;
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const indent = text.slice(lineStart, offset).match(/^[ \t]*/)![0];
  dispatch?.(state.tr.insertText("\n" + indent).scrollIntoView());
  return true;
};

const indent: Command = (state, dispatch) => {
  const $from = inCode(state);
  if (!$from) return false;
  if (state.selection.empty) {
    dispatch?.(state.tr.insertText(INDENT).scrollIntoView());
    return true;
  }
  const start = $from.start();
  const tr = state.tr;
  for (const line of lineStarts(state, $from).reverse()) tr.insertText(INDENT, start + line);
  dispatch?.(tr);
  return true;
};

const dedent: Command = (state, dispatch) => {
  const $from = inCode(state);
  if (!$from) return false;
  const text = $from.parent.textContent;
  const start = $from.start();
  const tr = state.tr;
  for (const line of lineStarts(state, $from).reverse()) {
    const width = text.slice(line).match(/^(\t| {1,2})?/)![0].length;
    if (width) tr.delete(start + line, start + line + width);
  }
  if (tr.docChanged) dispatch?.(tr);
  return true; // Tab never leaves the block.
};

/** Backspace in an empty code block turns it back into text. */
const removeEmpty: Command = (state, dispatch) => {
  const $from = inCode(state);
  if (!$from || $from.parent.content.size || !state.selection.empty) return false;
  return setBlockType(state.schema.nodes.paragraph)(state, dispatch);
};

/** ↓ on the last line of a code block at the end of the page adds a line of text after it. */
const leaveDown: Command = (state, dispatch) => {
  const $from = inCode(state);
  if (!$from || !state.selection.empty) return false;
  if ($from.parent.textContent.indexOf("\n", $from.parentOffset) >= 0) return false;
  if ($from.index(-1) < $from.node(-1).childCount - 1) return false;
  return exitCode(state, dispatch);
};

/** ⌘A in a code block selects its code first, then (pressed again) the page. */
const selectCode: Command = (state, dispatch) => {
  const $from = inCode(state);
  if (!$from) return false;
  const from = $from.start();
  const to = $from.end();
  if (state.selection.from === from && state.selection.to === to) return false;
  dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
  return true;
};

const PRIORITY = 100; // before the list and paragraph keys

export const codeKeymap = $useKeymap("pageCodeBlock", {
  Newline: { shortcuts: "Enter", priority: PRIORITY, command: () => newlineKeepingIndent },
  Indent: { shortcuts: "Tab", priority: PRIORITY, command: () => indent },
  Dedent: { shortcuts: "Shift-Tab", priority: PRIORITY, command: () => dedent },
  RemoveEmpty: { shortcuts: "Backspace", priority: PRIORITY, command: () => removeEmpty },
  Exit: { shortcuts: "Mod-Enter", priority: PRIORITY, command: () => (state, dispatch) => !!inCode(state) && exitCode(state, dispatch) },
  LeaveDown: { shortcuts: "ArrowDown", priority: PRIORITY, command: () => leaveDown },
  SelectCode: { shortcuts: "Mod-a", priority: PRIORITY, command: () => selectCode },
});
