import { describe, expect, test } from "vitest";
import { TextSelection } from "@milkdown/kit/prose/state";
import { type PageEditor, createPageEditor } from "../src/index.ts";
import { formatState, slashState } from "../src/commands.ts";

const open = (markdown: string) => createPageEditor({ root: document.createElement("div"), markdown });

/** Selects the first occurrence of `text` (or puts the cursor after it, with `cursor`). */
function select(editor: PageEditor, text: string, { cursor = false } = {}) {
  const { view } = editor;
  let found: { from: number; to: number } | null = null;
  view.state.doc.descendants((node, pos) => {
    if (found || !node.isText) return !found;
    const i = node.text!.indexOf(text);
    if (i >= 0) found = { from: pos + i, to: pos + i + text.length };
    return false;
  });
  if (!found) throw new Error(`"${text}" not in document`);
  const { from, to } = found;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cursor ? to : from, to)));
}

function type(editor: PageEditor, text: string) {
  editor.view.dispatch(editor.view.state.tr.insertText(text));
}

describe("inline formats", () => {
  test.each([
    ["bold", "Some **words** here.\n"],
    ["italic", "Some *words* here.\n"],
    ["strikethrough", "Some ~~words~~ here.\n"],
    ["code", "Some `words` here.\n"],
  ] as const)("%s", async (format, expected) => {
    const editor = await open("Some words here.\n");
    select(editor, "words");
    expect(editor.commands.toggle(format)).toBe(true);
    expect(editor.save()).toBe(expected);
    expect(formatState(editor.view.state).inline).toEqual(new Set([format]));
    editor.commands.toggle(format);
    expect(editor.save()).toBeNull(); // toggled back off: unchanged
    await editor.destroy();
  });

  test("links are set, read back and removed", async () => {
    const editor = await open("Some words here.\n");
    select(editor, "words");
    editor.commands.setLink("https://example.com");
    expect(editor.save()).toBe("Some [words](https://example.com) here.\n");
    expect(formatState(editor.view.state).link).toBe("https://example.com");
    editor.commands.setLink("");
    expect(editor.save()).toBeNull();
    await editor.destroy();
  });
});

describe("block formats", () => {
  test.each([
    ["heading1", "# Title words\n"],
    ["heading2", "## Title words\n"],
    ["heading3", "### Title words\n"],
    ["bulletList", "- Title words\n"],
    ["numberedList", "1. Title words\n"],
    ["taskList", "- [ ] Title words\n"],
    ["quote", "> Title words\n"],
  ] as const)("%s", async (format, expected) => {
    const editor = await open("Title words\n");
    select(editor, "Title", { cursor: true });
    expect(editor.commands.setBlock(format)).toBe(true);
    expect(editor.save()).toBe(expected);
    expect(formatState(editor.view.state).block).toBe(format);
    await editor.destroy();
  });

  test("a heading turns back into text", async () => {
    const editor = await open("## Title words\n");
    select(editor, "Title", { cursor: true });
    editor.commands.setBlock("text");
    expect(editor.save()).toBe("Title words\n");
    await editor.destroy();
  });

  test("code block, divider and table", async () => {
    const editor = await open("First paragraph.\n");
    select(editor, "paragraph.", { cursor: true });
    editor.commands.setBlock("codeBlock");
    expect(formatState(editor.view.state).inCode).toBe(true);
    expect(editor.save()).toBe("```\nFirst paragraph.\n```\n");
    await editor.destroy();

    const second = await open("Before.\n");
    select(second, "Before.", { cursor: true });
    second.commands.setBlock("divider");
    expect(second.save()).toMatch(/^Before\.\n\n---\n/);
    await second.destroy();

    const third = await open("Before.\n");
    select(third, "Before.", { cursor: true });
    third.commands.setBlock("table");
    expect(third.save()).toMatch(/\| +\| +\| +\|\n\| :?- \| :?- \| :?- \|\n/);
    await third.destroy();
  });
});

test("to-do items tick and untick", async () => {
  const editor = await open("- [ ] write the spec\n- [x] book the room\n");
  select(editor, "write", { cursor: true });
  editor.commands.toggleTask(editor.view.state.selection.from);
  expect(editor.save()).toBe("- [x] write the spec\n- [x] book the room\n");
  select(editor, "book", { cursor: true });
  editor.commands.toggleTask(editor.view.state.selection.from);
  expect(editor.save()).toBe("- [x] write the spec\n- [ ] book the room\n");
  await editor.destroy();
});

describe("slash commands", () => {
  test("detected only at the start of an empty paragraph", async () => {
    const editor = await open("Some words here.\n\nx\n");
    select(editor, "x", { cursor: true });
    expect(slashState(editor.view.state)).toBeNull();

    // Replace "x" with "/hea" as if typed.
    const { from } = editor.view.state.selection;
    editor.view.dispatch(editor.view.state.tr.insertText("/hea", from - 1, from));
    expect(slashState(editor.view.state)).toMatchObject({ query: "hea" });

    select(editor, "words", { cursor: true });
    type(editor, " /x");
    expect(slashState(editor.view.state)).toBeNull(); // not at the start
    await editor.destroy();
  });

  test("choosing a command replaces the typed text", async () => {
    const editor = await open("Intro.\n\nx\n");
    select(editor, "x", { cursor: true });
    const { from } = editor.view.state.selection;
    editor.view.dispatch(editor.view.state.tr.insertText("/h2", from - 1, from));
    editor.commands.runSlash("heading2");
    type(editor, "New section");
    expect(editor.save()).toBe("Intro.\n\n## New section\n");
    await editor.destroy();
  });
});

test("find selects the first match, ignoring case and formatting", async () => {
  const editor = await open("# Intro\n\nWe met **Acme** on Tuesday.\n\nAcme again.\n");
  expect(editor.commands.find("acme on")).toBe(true);
  const { from, to } = editor.view.state.selection;
  expect(editor.view.state.doc.textBetween(from, to)).toBe("Acme on");
  expect(editor.commands.find("zebra")).toBe(false);
});

test("linkAt finds a link's whole range, across formatting", async () => {
  const editor = await open("See [the **big** docs](https://x.org) now.\n");
  const { doc } = editor.view.state;
  let inside = 0;
  doc.descendants((node, pos) => {
    if (node.isText && node.text === "big") inside = pos + 1;
  });
  const link = editor.commands.linkAt(inside)!;
  expect(doc.textBetween(link.from, link.to)).toBe("the big docs");
  expect(link.href).toBe("https://x.org");
  expect(editor.commands.linkAt(2)).toBeNull();

  editor.commands.updateLinkAt(inside, "https://y.org");
  expect(editor.save()).toBe("See [the **big** docs](https://y.org) now.\n");
  editor.commands.updateLinkAt(inside, "https://y.org", "manual");
  expect(editor.save()).toBe("See [manual](https://y.org) now.\n");
  editor.commands.updateLinkAt(5, "");
  expect(editor.save()).toBe("See manual now.\n");
});
