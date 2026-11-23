import { describe, expect, test } from "vitest";
import { TextSelection } from "@milkdown/kit/prose/state";
import { type PageEditor, WRITE_HINT, createPageEditor, placeholderAt } from "../src/index.ts";

const open = (markdown: string) => createPageEditor({ root: document.createElement("div"), markdown });

/** Puts the cursor in the `index`th empty text block. */
function cursorInEmpty(editor: PageEditor, index = 0) {
  const { view } = editor;
  let seen = 0;
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (at >= 0) return false;
    if (node.isTextblock && node.content.size === 0 && seen++ === index) at = pos + 1;
    return at < 0;
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
}

const hint = (editor: PageEditor, focused = true) => placeholderAt(editor.view.state, focused)?.text ?? null;

describe("hints in empty blocks", () => {
  test("an empty page says how to start, focused or not", async () => {
    const editor = await open("");
    expect(hint(editor, false)).toBe(WRITE_HINT);
    expect(hint(editor, true)).toBe(WRITE_HINT);
  });

  test("the empty paragraph with the cursor, only while the editor has focus", async () => {
    const editor = await open("A.\n");
    editor.commands.continueAtEnd();
    expect(hint(editor)).toBe(WRITE_HINT);
    expect(hint(editor, false)).toBeNull();
  });

  test.each([
    ["heading2", "Heading 2"],
    ["bulletList", "List"],
    ["numberedList", "List"],
    ["taskList", "To-do"],
    ["quote", "Quote"],
  ] as const)("an empty %s says what it is", async (format, expected) => {
    const editor = await open("A.\n");
    editor.commands.continueAtEnd();
    editor.commands.setBlock(format);
    expect(hint(editor)).toBe(expected);
  });

  test("nothing in blocks with text, or in code blocks", async () => {
    const editor = await open("A.\n\n```\n\n```\n");
    expect(hint(editor)).toBeNull();
    cursorInEmpty(editor);
    expect(hint(editor)).toBeNull();
  });

  test("the hint is never saved", async () => {
    const editor = await open("A.\n");
    editor.commands.continueAtEnd();
    expect(editor.save()).toBeNull();
  });
});
