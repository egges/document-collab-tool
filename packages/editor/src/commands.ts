// Formatting commands and the editor state the UI needs (active formats, the
// slash command being typed). Kept free of any UI framework so it can be
// tested without a browser; the React toolbar and menu only call these.
import { type Editor, editorViewCtx, serializerCtx } from "@milkdown/kit/core";
import {
  createCodeBlockCommand,
  insertHrCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInHeadingCommand,
} from "@milkdown/kit/preset/commonmark";
import { insertTableCommand, toggleStrikethroughCommand } from "@milkdown/kit/preset/gfm";
import { lift } from "@milkdown/kit/prose/commands";
import type { MarkType, Node } from "@milkdown/kit/prose/model";
import { type EditorState, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { callCommand } from "@milkdown/kit/utils";
import {
  type Block,
  blockAt,
  continueAtEnd,
  deleteBlock,
  duplicateBlock,
  focusBlock,
  insertBlock,
  moveBlockStep,
  moveBlockTo,
  selectBlock,
} from "./blocks.ts";
import { itemAtCursor, itemToText, setListType } from "./lists.ts";
import { prepareForSave } from "./markdown.ts";
import {
  type TableCell,
  type TableEdit,
  type TableLayout,
  type TableLine,
  editTable,
  moveTableLine,
  setTableWidths,
  tableCellAt,
} from "./tables.ts";

export type InlineFormat = "bold" | "italic" | "strikethrough" | "code";

export type BlockFormat =
  | "text"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "numberedList"
  | "taskList"
  | "quote"
  | "codeBlock"
  | "divider"
  | "table";

const MARKS: Record<InlineFormat, string> = {
  bold: "strong",
  italic: "emphasis",
  strikethrough: "strike_through",
  code: "inlineCode",
};

const TOGGLES = {
  bold: toggleStrongCommand,
  italic: toggleEmphasisCommand,
  strikethrough: toggleStrikethroughCommand,
  code: toggleInlineCodeCommand,
};

export interface FormatState {
  /** Inline formats active on the whole selection (or at the cursor). */
  inline: Set<InlineFormat>;
  /** The link at the selection, if any. */
  link: string | null;
  /** Type of the block the selection starts in, if it's one of ours. */
  block: BlockFormat | null;
  /** True inside a code block, where formatting doesn't apply. */
  inCode: boolean;
}

function markActive(state: EditorState, type: MarkType): boolean {
  const { from, to, empty, $from } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks ?? $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

function blockFormatAt(state: EditorState): BlockFormat | null {
  const { $from } = state.selection;
  const block = $from.parent;
  if (block.type.name === "code_block") return "codeBlock";
  if (block.type.name === "heading") {
    const level = block.attrs.level as number;
    return level <= 3 ? (`heading${level}` as BlockFormat) : null;
  }
  // An item's line is the item; a paragraph in a quote is the quote.
  const item = itemAtCursor(state);
  if (item?.node.attrs.checked != null) return "taskList";
  if (item) return item.node.attrs.listType === "ordered" ? "numberedList" : "bulletList";
  if ($from.depth > 1 && $from.node(-1).type.name === "blockquote") return "quote";
  return block.type.name === "paragraph" ? "text" : null;
}

export function formatState(state: EditorState): FormatState {
  const inline = new Set<InlineFormat>();
  for (const [format, name] of Object.entries(MARKS) as [InlineFormat, string][]) {
    const type = state.schema.marks[name];
    if (type && markActive(state, type)) inline.add(format);
  }
  const linkType = state.schema.marks.link;
  const { $from } = state.selection;
  const link = linkType?.isInSet($from.marks()) ?? linkType?.isInSet($from.nodeAfter?.marks ?? []);
  const block = blockFormatAt(state);
  return { inline, link: link ? (link.attrs.href as string) : null, block, inCode: block === "codeBlock" };
}

/** A slash command being typed: "/" at the start of an otherwise empty paragraph, then a query. */
export interface SlashState {
  query: string;
  /** Range of "/query" in the document, removed when a command is chosen. */
  from: number;
  to: number;
}

export function slashState(state: EditorState): SlashState | null {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.name !== "paragraph") return null;
  const text = $from.parent.textContent;
  const match = text.match(/^\/([\w ]{0,20})$/);
  if (!match || $from.parentOffset !== text.length) return null;
  const start = $from.start();
  return { query: match[1], from: start, to: start + text.length };
}

/** Commands, bound to one Milkdown editor. */
export function createCommands(editor: Editor) {
  const run = (key: Parameters<typeof callCommand>[0], payload?: unknown) =>
    editor.action(callCommand(key, payload));
  const view = () => editor.action((ctx) => ctx.get(editorViewCtx));

  return {
    toggle(format: InlineFormat): boolean {
      return run(TOGGLES[format].key);
    },

    /** Sets the link on the selection, or removes it when `href` is empty. */
    setLink(href: string): boolean {
      const v = view();
      const type = v.state.schema.marks.link;
      const { from, to, empty } = v.state.selection;
      if (empty) return false;
      const tr = v.state.tr.removeMark(from, to, type);
      if (href) tr.addMark(from, to, type.create({ href }));
      v.dispatch(tr);
      return true;
    },

    /** The link at document position `pos`: its whole range and address. */
    linkAt(pos: number): LinkRange | null {
      return linkAt(view().state, pos);
    },

    /**
     * Changes the link at `pos`: its address, and its text when `text` is
     * given and differs. An empty `href` removes the link, keeping its text.
     */
    updateLinkAt(pos: number, href: string, text?: string): boolean {
      const v = view();
      const link = linkAt(v.state, pos);
      if (!link) return false;
      const type = v.state.schema.marks.link;
      const tr = v.state.tr;
      let { from, to } = link;
      // Keep the rest of the link (its "title"), change only the address.
      const attrs = type.isInSet(v.state.doc.resolve(from + 1).marks())?.attrs ?? {};
      if (text !== undefined && text !== "" && text !== v.state.doc.textBetween(from, to)) {
        // New text takes the formatting of the link's first character.
        const marks = v.state.doc.resolve(from + 1).marks().filter((m) => m.type !== type);
        tr.replaceWith(from, to, v.state.schema.text(text, marks));
        to = from + text.length;
      }
      tr.removeMark(from, to, type);
      if (href) tr.addMark(from, to, type.create({ ...attrs, href }));
      v.dispatch(tr);
      return true;
    },

    /**
     * Turns the block the cursor is in into `format`. A list item turned
     * into anything else becomes that, in place; a quote's paragraph turned
     * into text, a heading or code leaves the quote.
     */
    setBlock(format: BlockFormat): boolean {
      const v = view();
      if (format === "bulletList" || format === "numberedList" || format === "taskList") {
        const listType = format === "bulletList" ? "bullet" : format === "numberedList" ? "ordered" : null;
        return dispatchIf(v, setListType(v.state, listType, format === "taskList"));
      }
      // A rule or table can't be an item's line, so the item becomes text first.
      dispatchIf(v, itemToText(v.state));
      if (format === "divider") return run(insertHrCommand.key);
      if (format === "table") return run(insertTableCommand.key, { row: 3, col: 3 });
      if (format !== "quote") leaveQuote(v);
      switch (format) {
        case "text":
          return run(turnIntoTextCommand.key) || v.state.selection.$from.parent.type.name === "paragraph";
        case "heading1":
        case "heading2":
        case "heading3":
          return run(wrapInHeadingCommand.key, Number(format.slice(-1)));
        case "quote":
          return run(wrapInBlockquoteCommand.key);
        case "codeBlock":
          return run(createCodeBlockCommand.key);
      }
    },

    /** Ticks or unticks the to-do item containing document position `pos`. */
    toggleTask(pos: number): boolean {
      const v = view();
      const $pos = v.state.doc.resolve(pos);
      for (let depth = $pos.depth; depth > 0; depth--) {
        const node = $pos.node(depth);
        if (node.type.name === "list_item" && node.attrs.checked != null) {
          v.dispatch(v.state.tr.setNodeMarkup($pos.before(depth), undefined, { ...node.attrs, checked: !node.attrs.checked }));
          return true;
        }
      }
      return false;
    },

    /**
     * Selects the first place `text` appears (ignoring case) and scrolls to
     * it, for opening a page from a search. False if it isn't there.
     */
    find(text: string): boolean {
      const v = view();
      const range = findText(v.state.doc, text);
      if (!range) return false;
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, range.from, range.to)).scrollIntoView());
      return true;
    },

    /** The table cell at document position `pos` (by default the cursor). */
    tableCellAt(pos?: number): TableCell | null {
      const { state } = view();
      return tableCellAt(state, pos ?? state.selection.from);
    },

    /**
     * Adds or removes a row or column at `cell` (see tables.ts for what's
     * allowed), and puts the cursor in the new row or column.
     */
    editTable(cell: TableCell, edit: TableEdit): boolean {
      const v = view();
      const tr = editTable(v.state, cell, edit);
      if (!tr) return false;
      v.dispatch(tr);
      v.focus();
      return true;
    },

    /** Moves the row or column through `cell` to index `to` (see tables.ts). */
    moveTableLine(cell: TableCell, line: TableLine, to: number): boolean {
      const v = view();
      const tr = moveTableLine(v.state, cell, line, to);
      if (!tr) return false;
      v.dispatch(tr);
      v.focus();
      return true;
    },

    /**
     * Sizes the columns of the table at `cell` (see "Column widths" in
     * tables.ts), as one undo step. Keeps the cursor where it is.
     */
    setTableWidths(cell: TableCell, layout: TableLayout, widths?: number[]): boolean {
      const v = view();
      const tr = setTableWidths(v.state, cell.table, layout, widths);
      if (!tr) return false;
      v.dispatch(tr);
      return true;
    },

    /** The block at document position `pos` (a top-level element or a list item). */
    blockAt(pos: number): Block | null {
      return blockAt(view().state.doc, pos);
    },

    /** Selects the whole block. */
    selectBlock(block: Block): void {
      const v = view();
      v.dispatch(selectBlock(v.state, block));
    },

    deleteBlock(block: Block): void {
      const v = view();
      v.dispatch(deleteBlock(v.state, block));
    },

    duplicateBlock(block: Block): void {
      const v = view();
      v.dispatch(duplicateBlock(v.state, block));
    },

    /** Moves the block one step up (-1) or down (1). False when it can't go further. */
    moveBlock(block: Block, direction: -1 | 1): boolean {
      const v = view();
      return dispatchIf(v, moveBlockStep(v.state, block, direction));
    },

    /** Moves the block to `target`, a position between blocks (see `dropTarget`). */
    moveBlockTo(block: Block, target: number): boolean {
      const v = view();
      return dispatchIf(v, moveBlockTo(v.state, block, target));
    },

    /** Adds an empty block below (or above) and puts the cursor in it, optionally starting with `text`. */
    insertBlock(block: Block, options?: { above?: boolean; text?: string }): void {
      const v = view();
      v.dispatch(insertBlock(v.state, block, options));
    },

    /** Puts the cursor in an empty block at the end of the page, adding one if needed (a click below the last block). */
    continueAtEnd(): void {
      const v = view();
      v.dispatch(continueAtEnd(v.state));
      v.focus();
    },

    /** The block as Markdown, as it would be saved (a list item with its list marker). */
    blockMarkdown(block: Block): string {
      const { state } = view();
      const doc = state.schema.topNodeType.create(null, block.node);
      return editor.action((ctx) => ctx.get(serializerCtx)(prepareForSave(doc))).trimEnd();
    },

    /** Turns the block into `format` (see `setBlock`). */
    turnBlockInto(block: Block, format: BlockFormat): boolean {
      const v = view();
      const tr = focusBlock(v.state, block);
      if (!tr) return false;
      v.dispatch(tr);
      return this.setBlock(format);
    },

    /** Replaces the "/query" being typed with the chosen block. */
    runSlash(format: BlockFormat): boolean {
      const v = view();
      const slash = slashState(v.state);
      if (slash) v.dispatch(v.state.tr.delete(slash.from, slash.to));
      return this.setBlock(format);
    },
  };
}

export type Commands = ReturnType<typeof createCommands>;

function dispatchIf(view: EditorView, tr: Transaction | null): boolean {
  if (tr) view.dispatch(tr);
  return tr !== null;
}

/** Takes the cursor's block out of any quotes. */
function leaveQuote(view: EditorView): void {
  const inQuote = () => {
    const { $from } = view.state.selection;
    for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type.name === "blockquote") return true;
    return false;
  };
  for (let i = 0; i < 20 && inQuote(); i++) {
    if (!lift(view.state, view.dispatch)) break;
  }
}

/** Document range of the first place `text` appears in one text block, ignoring case. */
export function findText(doc: Node, text: string): { from: number; to: number } | null {
  const needle = text.trim().toLowerCase();
  if (!needle) return null;
  let found: { from: number; to: number } | null = null;
  doc.descendants((block, blockPos) => {
    if (found) return false;
    if (!block.isTextblock) return true;
    // The block's text, lowercased, with the document position of each character.
    let lower = "";
    const positions: number[] = [];
    block.forEach((child, offset) => {
      if (!child.isText) return;
      for (let i = 0; i < child.text!.length; i++) {
        const c = child.text![i].toLowerCase();
        lower += c;
        for (let k = 0; k < c.length; k++) positions.push(blockPos + 1 + offset + i);
      }
    });
    const at = lower.indexOf(needle);
    if (at >= 0) found = { from: positions[at], to: positions[at + needle.length - 1] + 1 };
    return false;
  });
  return found;
}

export interface LinkRange {
  from: number;
  to: number;
  href: string;
}

/** The link covering `pos` (or starting or ending there), extended over all of its text. */
export function linkAt(state: EditorState, pos: number): LinkRange | null {
  const type = state.schema.marks.link;
  if (!type || pos < 0 || pos > state.doc.content.size) return null;
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.inlineContent || parent.childCount === 0) return null;
  let index = Math.min($pos.index(), parent.childCount - 1);
  let mark = type.isInSet(parent.child(index).marks);
  if (!mark && index > 0 && $pos.textOffset === 0) {
    index -= 1;
    mark = type.isInSet(parent.child(index).marks);
  }
  if (!mark) return null;
  let start = index;
  let end = index + 1;
  while (start > 0 && mark.isInSet(parent.child(start - 1).marks)) start--;
  while (end < parent.childCount && mark.isInSet(parent.child(end).marks)) end++;
  let offset = 0;
  let from = 0;
  for (let i = 0; i < end; i++) {
    if (i === start) from = offset;
    offset += parent.child(i).nodeSize;
  }
  return { from: $pos.start() + from, to: $pos.start() + offset, href: mark.attrs.href as string };
}
