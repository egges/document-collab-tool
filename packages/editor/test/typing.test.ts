// Autosave runs while people type, so it sees half-typed states: a trailing
// space before the next word, a line break before the next line. Saving
// must never refuse those, and must write what the page will show.
import { describe, expect, test } from "vitest";
import { createPageEditor, findLostContent } from "../src/index.ts";

async function typeAtEnd(start: string, edit: (view: import("@milkdown/kit/prose/view").EditorView, end: number) => void) {
  const root = document.createElement("div");
  document.body.append(root);
  const editor = await createPageEditor({ root, markdown: start });
  let end = 1;
  editor.view.state.doc.descendants((node, pos) => {
    if (node.isTextblock) end = pos + node.nodeSize - 1;
  });
  edit(editor.view, end);
  try {
    return editor.save();
  } finally {
    await editor.destroy();
  }
}

const typing = (start: string, text: string) =>
  typeAtEnd(start, (view, end) => view.dispatch(view.state.tr.insertText(text, end)));

describe("saving while typing", () => {
  test.each([
    // [what, page, typed at the end, saved (null: nothing new to save)]
    ["a space before the next word", "", "This is great. ", "This is great.\n"],
    ["only spaces", "", "   ", null],
    ["a space after a heading", "# Title\n", " ", null],
    ["a space in a list item", "- item\n", " ", null],
    ["a space in a quote", "> quote\n", " ", null],
    ["a space after bold text", "**bold**\n", " ", null],
    ["a space in a table cell", "| a | b |\n| - | - |\n| c | d |\n", " ", null],
    ["a space after the next word", "This is great.\n", " Well ", "This is great. Well\n"],
  ])("%s", async (_what, page, typed, saved) => {
    expect(await typing(page, typed)).toBe(saved);
  });

  test("keeps spaces in code", async () => {
    expect(await typing("```\ncode\n```\n", "  ")).toBe("```\ncode  \n```\n");
  });

  test("a line break at the end of a paragraph, before the next line is typed", async () => {
    const breakThen = (text: string) =>
      typeAtEnd("Line\n", (view, end) => {
        let tr = view.state.tr.insert(end, view.state.schema.nodes.hardbreak.create());
        if (text) tr = tr.insertText(text, end + 1);
        view.dispatch(tr);
      });
    expect(await breakThen("")).toBeNull();
    // Without trimming this was written as "Line\\" plus a space: a stray backslash.
    expect(await breakThen(" ")).toBeNull();
    expect(await breakThen("next")).toMatch(/^Line(\\|  )\nnext\n$/);
  });
});

describe("the safety check still catches real losses", () => {
  test("text at the end of a block", async () => {
    const root = document.createElement("div");
    const editor = await createPageEditor({ root, markdown: "" });
    const parse = (md: string) => {
      editor.load(md);
      return editor.view.state.doc;
    };
    const lost = findLostContent(parse("This is great. Really"), parse("This is great."));
    expect(lost).toContain("Really");
    expect(findLostContent(parse("Code:\n\n```\nx  \n```"), parse("Code:\n\n```\nx\n```"))).not.toBeNull();
    await editor.destroy();
  });
});
