// Typing in code blocks, as in a code editor: ``` starts one; Enter keeps
// the indentation (and adds a level after an opening bracket); Tab, ⌘] and
// ⌘[ indent; ⌥↑/⌥↓ move lines and ⇧⌥↑/⇧⌥↓ copy them; ⌘/ comments lines
// out; Home goes to the first character of the line. And there are ways out:
// ⌘↩, ↑/↓ past the first or last line, Backspace in an empty block.
import { exitCode, setBlockType } from "@milkdown/kit/prose/commands";
import { textblockTypeInputRule } from "@milkdown/kit/prose/inputrules";
import type { Node, ResolvedPos } from "@milkdown/kit/prose/model";
import { type Command, type EditorState, Plugin, TextSelection } from "@milkdown/kit/prose/state";
import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import { $inputRule, $prose, $useKeymap } from "@milkdown/kit/utils";
import { shownLanguage } from "./highlight.ts";

export const INDENT = "  ";

/** Typing ``` at the start of a line turns it into a code block straight away. */
export const codeFenceInputRule = $inputRule((ctx) => textblockTypeInputRule(/^```$/, codeBlockSchema.type(ctx)));

/** The code block the selection is in, with offsets into its text. */
interface Code {
  node: Node;
  /** Document position of the start of the code. */
  start: number;
  text: string;
  /** Selection, as offsets into `text`. */
  from: number;
  to: number;
  $from: ResolvedPos;
}

function inCode(state: EditorState): Code | null {
  const { $from, $to, from, to } = state.selection;
  if (!$from.parent.type.spec.code || !$from.sameParent($to)) return null;
  const start = $from.start();
  return { node: $from.parent, start, text: $from.parent.textContent, from: from - start, to: to - start, $from };
}

const lineStart = (text: string, offset: number) => text.lastIndexOf("\n", offset - 1) + 1;
const lineEnd = (text: string, offset: number) => {
  const i = text.indexOf("\n", offset);
  return i < 0 ? text.length : i;
};
const indentOf = (line: string) => line.match(/^[ \t]*/)![0];

/**
 * The whole lines the selection touches, as [start, end) offsets. A selection
 * ending at the very start of a line doesn't include that line.
 */
function selectedLines(code: Code): [number, number] {
  const { text, from, to } = code;
  const last = to > from && to === lineStart(text, to) ? to - 1 : to;
  return [lineStart(text, from), lineEnd(text, last)];
}

/** Starts of the lines from `start` to `end`. */
function starts(text: string, start: number, end: number): number[] {
  const result = [start];
  for (let i = text.indexOf("\n", start); i >= 0 && i < end; i = text.indexOf("\n", i + 1)) result.push(i + 1);
  return result;
}

/** Puts the text selection at `from`–`to` (offsets in the block, after the change). */
function select(code: Code, tr: EditorState["tr"], from: number, to = from) {
  return tr.setSelection(TextSelection.create(tr.doc, code.start + from, code.start + to));
}

export const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`" };
const CLOSERS = new Set([")", "]", "}"]);

/** Languages where a line ending in ":" opens a block. */
const COLON_BLOCKS = new Set(["python", "yaml"]);

const newline: Command = (state, dispatch) => {
  const code = inCode(state);
  if (!code) return false;
  const { text, from, to } = code;
  const before = text.slice(lineStart(text, from), from);
  const indent = indentOf(before);
  const opener = before.trimEnd().at(-1);
  const closer = text[to];
  const tr = state.tr;
  if (opener && PAIRS[opener] === closer && CLOSERS.has(closer)) {
    // Between brackets: the cursor gets its own, indented line, the closer the next.
    tr.insertText(`\n${indent}${INDENT}\n${indent}`, code.start + from, code.start + to);
    select(code, tr, from + 1 + indent.length + INDENT.length);
  } else {
    const opens = (opener && "([{".includes(opener)) || (opener === ":" && COLON_BLOCKS.has(shownLanguage(code.node) ?? ""));
    tr.insertText(`\n${indent}${opens ? INDENT : ""}`, code.start + from, code.start + to);
  }
  dispatch?.(tr.scrollIntoView());
  return true;
};

function indentLines(state: EditorState, dispatch: ((tr: EditorState["tr"]) => void) | undefined, code: Code): boolean {
  const [start, end] = selectedLines(code);
  const tr = state.tr;
  for (const line of starts(code.text, start, end).reverse()) tr.insertText(INDENT, code.start + line);
  dispatch?.(tr);
  return true;
}

const indent: Command = (state, dispatch) => {
  const code = inCode(state);
  if (!code) return false;
  if (state.selection.empty) {
    dispatch?.(state.tr.insertText(INDENT).scrollIntoView());
    return true;
  }
  return indentLines(state, dispatch, code);
};

const indentLine: Command = (state, dispatch) => {
  const code = inCode(state);
  return !!code && indentLines(state, dispatch, code);
};

const dedent: Command = (state, dispatch) => {
  const code = inCode(state);
  if (!code) return false;
  const [start, end] = selectedLines(code);
  const tr = state.tr;
  for (const line of starts(code.text, start, end).reverse()) {
    const width = code.text.slice(line).match(/^(\t| {1,2})?/)![0].length;
    if (width) tr.delete(code.start + line, code.start + line + width);
  }
  if (tr.docChanged) dispatch?.(tr);
  return true; // Tab never leaves the block.
};

/**
 * Backspace: in an empty block, back to text; at the very start, nothing
 * (joined to the block above, the code's line breaks would end up in a
 * paragraph); between an empty pair, both go; in the indentation, back one
 * level.
 */
const backspace: Command = (state, dispatch) => {
  const code = inCode(state);
  if (!code || !state.selection.empty) return false;
  const { text, from } = code;
  if (!text) return setBlockType(state.schema.nodes.paragraph)(state, dispatch);
  if (from === 0) return true;
  const prev = text[from - 1];
  if (prev && PAIRS[prev] && text[from] === PAIRS[prev]) {
    dispatch?.(state.tr.delete(code.start + from - 1, code.start + from + 1));
    return true;
  }
  const before = text.slice(lineStart(text, from), from);
  if (before.length >= 2 && /^ +$/.test(before)) {
    const width = before.length % INDENT.length || INDENT.length;
    dispatch?.(state.tr.delete(code.start + from - width, code.start + from));
    return true;
  }
  return false;
};

/** Home: to the first character of the line, then (again) to its very start. */
function home(extend: boolean): Command {
  return (state, dispatch) => {
    const code = inCode(state);
    if (!code) return false;
    const { text } = code;
    const head = state.selection.head - code.start;
    const start = lineStart(text, head);
    const first = start + indentOf(text.slice(start, lineEnd(text, start))).length;
    const target = head === first ? start : first;
    const anchor = extend ? state.selection.anchor - code.start : target;
    dispatch?.(select(code, state.tr, anchor, target).scrollIntoView());
    return true;
  };
}

function end(extend: boolean): Command {
  return (state, dispatch) => {
    const code = inCode(state);
    if (!code) return false;
    const head = state.selection.head - code.start;
    const target = lineEnd(code.text, head);
    const anchor = extend ? state.selection.anchor - code.start : target;
    dispatch?.(select(code, state.tr, anchor, target).scrollIntoView());
    return true;
  };
}

/** ⌥↑ / ⌥↓: moves the selected lines past the line above or below. */
function moveLines(down: boolean): Command {
  return (state, dispatch) => {
    const code = inCode(state);
    if (!code) return false;
    const { text, from, to } = code;
    const [start, end] = selectedLines(code);
    const lines = text.slice(start, end);
    if (down) {
      if (end >= text.length) return true;
      const nextEnd = lineEnd(text, end + 1);
      const next = text.slice(end + 1, nextEnd);
      const tr = state.tr.insertText(`${next}\n${lines}`, code.start + start, code.start + nextEnd);
      dispatch?.(select(code, tr, from + next.length + 1, to + next.length + 1).scrollIntoView());
    } else {
      if (start === 0) return true;
      const prevStart = lineStart(text, start - 1);
      const prev = text.slice(prevStart, start - 1);
      const tr = state.tr.insertText(`${lines}\n${prev}`, code.start + prevStart, code.start + end);
      dispatch?.(select(code, tr, from - prev.length - 1, to - prev.length - 1).scrollIntoView());
    }
    return true;
  };
}

/** ⇧⌥↑ / ⇧⌥↓: copies the selected lines above or below. */
function copyLines(down: boolean): Command {
  return (state, dispatch) => {
    const code = inCode(state);
    if (!code) return false;
    const { text, from, to } = code;
    const [start, end] = selectedLines(code);
    const lines = text.slice(start, end);
    const tr = state.tr.insertText(`\n${lines}`, code.start + end);
    const shift = down ? lines.length + 1 : 0;
    dispatch?.(select(code, tr, from + shift, to + shift).scrollIntoView());
    return true;
  };
}

/** How each language comments out a line. */
const LINE_COMMENTS: Record<string, string> = {
  bash: "#", python: "#", ruby: "#", yaml: "#", toml: "#", r: "#", elixir: "#", dockerfile: "#",
  makefile: "#", powershell: "#", graphql: "#",
  javascript: "//", typescript: "//", c: "//", cpp: "//", csharp: "//", java: "//", go: "//",
  rust: "//", swift: "//", kotlin: "//", scala: "//", dart: "//", php: "//", scss: "//", objectivec: "//",
  sql: "--", lua: "--", haskell: "--",
  latex: "%",
};

/** ⌘/: comments the selected lines out, or back in if they all are. */
export const toggleComment: Command = (state, dispatch) => {
  const code = inCode(state);
  if (!code) return false;
  const prefix = LINE_COMMENTS[shownLanguage(code.node) ?? ""];
  if (!prefix) return true; // nothing to do, but don't let ⌘/ fall through
  const { text } = code;
  const [start, end] = selectedLines(code);
  const lines = starts(text, start, end).map((s) => ({ start: s, text: text.slice(s, lineEnd(text, s)) }));
  const filled = lines.filter((l) => l.text.trim());
  if (!filled.length) return true;
  const commented = filled.every((l) => l.text.trimStart().startsWith(prefix));
  const column = Math.min(...filled.map((l) => indentOf(l.text).length));
  const tr = state.tr;
  for (const line of [...filled].reverse()) {
    if (commented) {
      const at = line.start + indentOf(line.text).length;
      const width = prefix.length + (text[at + prefix.length] === " " ? 1 : 0);
      tr.delete(code.start + at, code.start + at + width);
    } else {
      tr.insertText(`${prefix} `, code.start + line.start + column);
    }
  }
  dispatch?.(tr);
  return true;
};

/** ↓ on the last line of a code block at the end of the page adds a line of text after it. */
const leaveDown: Command = (state, dispatch) => {
  const code = inCode(state);
  if (!code || !state.selection.empty) return false;
  if (code.text.indexOf("\n", code.from) >= 0) return false;
  const { $from } = code;
  if ($from.index(-1) < $from.node(-1).childCount - 1) return false;
  return exitCode(state, dispatch);
};

/** ↑ on the first line of a code block at the top of the page adds a line of text before it. */
const leaveUp: Command = (state, dispatch) => {
  const code = inCode(state);
  if (!code || !state.selection.empty) return false;
  if (code.text.lastIndexOf("\n", code.from - 1) >= 0) return false;
  const { $from } = code;
  if ($from.index(-1) > 0) return false;
  const before = $from.before();
  const tr = state.tr.insert(before, state.schema.nodes.paragraph.create());
  dispatch?.(tr.setSelection(TextSelection.create(tr.doc, before + 1)).scrollIntoView());
  return true;
};

/** ⌘A in a code block selects its code first, then (pressed again) the page. */
const selectCode: Command = (state, dispatch) => {
  const code = inCode(state);
  if (!code) return false;
  if (code.from === 0 && code.to === code.text.length) return false;
  dispatch?.(select(code, state.tr, 0, code.text.length));
  return true;
};

const PRIORITY = 100; // before the list and paragraph keys
const key = (shortcuts: string | string[], command: Command) => ({ shortcuts, priority: PRIORITY, command: () => command });

export const codeKeymap = $useKeymap("pageCodeBlock", {
  Newline: key(["Enter", "Shift-Enter"], newline),
  Indent: key("Tab", indent),
  Dedent: key(["Shift-Tab", "Mod-["], dedent),
  IndentLine: key("Mod-]", indentLine),
  Backspace: key("Backspace", backspace),
  Home: key(["Home", "Meta-ArrowLeft"], home(false)),
  SelectHome: key(["Shift-Home", "Shift-Meta-ArrowLeft"], home(true)),
  End: key(["End", "Meta-ArrowRight"], end(false)),
  SelectEnd: key(["Shift-End", "Shift-Meta-ArrowRight"], end(true)),
  MoveUp: key("Alt-ArrowUp", moveLines(false)),
  MoveDown: key("Alt-ArrowDown", moveLines(true)),
  CopyUp: key("Shift-Alt-ArrowUp", copyLines(false)),
  CopyDown: key("Shift-Alt-ArrowDown", copyLines(true)),
  Comment: key("Mod-/", toggleComment),
  Exit: key("Mod-Enter", (state, dispatch) => !!inCode(state) && exitCode(state, dispatch)),
  LeaveDown: key("ArrowDown", leaveDown),
  LeaveUp: key("ArrowUp", leaveUp),
  SelectCode: key("Mod-a", selectCode),
});

/**
 * Brackets and quotes come in pairs: typing an opener adds its closer,
 * typing a closer that's already there steps over it, and an opener typed
 * with text selected wraps the selection.
 */
export const autoPairs = $prose(
  () =>
    new Plugin({
      props: {
        handleTextInput(view, from, to, typed) {
          const code = inCode(view.state);
          if (!code || typed.length !== 1) return false;
          const { text } = code;
          const offset = from - code.start;
          const next = text[to - code.start];
          const closer = PAIRS[typed];
          const isQuote = closer === typed;

          // Step over a closer that's already there.
          if ((CLOSERS.has(typed) || isQuote) && from === to && next === typed) {
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from + 1)));
            return true;
          }
          if (!closer) return false;
          if (from !== to) {
            const tr = view.state.tr.insertText(closer, to).insertText(typed, from);
            view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 1, to + 1)));
            return true;
          }
          // Only before space, the end of a line, or a closer, so typing in front of a word doesn't pair.
          if (next !== undefined && !/[\s)\]},;:]/.test(next)) return false;
          if (isQuote) {
            const prev = text[offset - 1];
            if (prev && /[\w\\]/.test(prev)) return false; // don't, it's, \"
            if (typed === "'" && shownLanguage(code.node) === "rust") return false; // lifetimes
          }
          const tr = view.state.tr.insertText(typed + closer, from, to);
          view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 1)));
          return true;
        },
      },
    }),
);
