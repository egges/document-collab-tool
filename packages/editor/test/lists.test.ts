import { describe, expect, test } from "vitest";
import { TextSelection } from "@milkdown/kit/prose/state";
import { type PageEditor, blockAt, createPageEditor, dropTargets } from "../src/index.ts";
import { pickTarget } from "../src/react/geometry.ts";
import { editOneWord } from "./helpers.ts";

const open = (markdown: string) => createPageEditor({ root: document.createElement("div"), markdown });

/** Puts the cursor in the text block containing `text`: after it, or at its start with `atStart`. */
function cursor(editor: PageEditor, text: string, { atStart = false } = {}) {
  const { view } = editor;
  let pos = -1;
  view.state.doc.descendants((node, p) => {
    if (pos >= 0 || !node.isText || !node.text!.includes(text)) return pos < 0;
    pos = p + node.text!.indexOf(text) + (atStart ? 0 : text.length);
    return false;
  });
  if (pos < 0) throw new Error(`"${text}" not in document`);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}

function press(editor: PageEditor, key: string, mods: KeyboardEventInit = {}) {
  const { view } = editor;
  const event = new KeyboardEvent("keydown", { key, ...mods });
  return view.someProp("handleKeyDown", (f) => f(view, event)) ?? false;
}

/** Types `text` a character at a time, so input rules run. */
function type(editor: PageEditor, text: string) {
  const { view } = editor;
  for (const ch of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)));
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
  }
}

const items = (editor: PageEditor) => {
  const out: string[] = [];
  editor.view.state.doc.forEach((node) => out.push(node.type.name));
  return out;
};

describe("items are blocks side by side", () => {
  test("a list is read as its items, with no list around them", async () => {
    const editor = await open("Intro.\n\n- one\n- two\n\n1. first\n");
    expect(items(editor)).toEqual(["paragraph", "list_item", "list_item", "list_item"]);
  });

  test("and written back as lists, unchanged", async () => {
    const pages = [
      "- one\n- two\n  - inner\n- three\n",
      "1. a\n2. b\n\n1) c\n2) d\n",
      "3. three\n4. four\n",
      "- one\n\n1. first\n2. second\n",
      "- loose\n\n- items\n",
      "- [ ] to do\n- [x] done\n",
      "- item\n\n  More text in it.\n\n- next\n",
    ];
    for (const page of pages) {
      const editor = await open(`Some words here.\n\n${page}`);
      editOneWord(editor.view);
      expect(editor.save()).toBe(`Some EDITED here.\n\n${page}`);
    }
  });

  test("a block between items splits the list, and numbers start again after it", async () => {
    const editor = await open("1. one\n2. two\n");
    cursor(editor, "one");
    press(editor, "Enter");
    press(editor, "Backspace"); // the new item becomes text
    type(editor, "Between.");
    expect(editor.save()).toBe("1. one\n\nBetween.\n\n1. two\n");
  });
});

describe("Enter", () => {
  test("adds an item of the same kind after it, unticked", async () => {
    const editor = await open("- [x] done\n");
    cursor(editor, "done");
    expect(press(editor, "Enter")).toBe(true);
    type(editor, "next");
    expect(editor.save()).toBe("- [x] done\n- [ ] next\n");
  });

  test("splits the item's text", async () => {
    const editor = await open("1. onetwo\n");
    cursor(editor, "one");
    press(editor, "Enter");
    expect(editor.save()).toBe("1. one\n2. two\n");
  });

  test("at the start, adds an empty item above", async () => {
    const editor = await open("- [x] done\n");
    cursor(editor, "done", { atStart: true });
    press(editor, "Enter");
    const [empty, done] = [0, 1].map((i) => editor.view.state.doc.child(i));
    expect([empty.textContent, empty.attrs.checked]).toEqual(["", false]);
    expect([done.textContent, done.attrs.checked]).toEqual(["done", true]);
    expect(editor.view.state.selection.$from.parent.textContent).toBe("done");
  });

  test("at the end of an item with nested blocks, the new item is the first of them", async () => {
    const editor = await open("- one\n  - inner\n");
    cursor(editor, "one");
    press(editor, "Enter");
    type(editor, "new");
    expect(editor.save()).toBe("- one\n  - new\n  - inner\n");
  });

  test("on an empty item: out a level, then into text", async () => {
    const editor = await open("- one\n  - inner\n");
    cursor(editor, "inner");
    press(editor, "Enter");
    press(editor, "Enter");
    type(editor, "x");
    expect(editor.save()).toBe("- one\n  - inner\n- x\n");
    const end = editor.view.state.selection.from;
    editor.view.dispatch(editor.view.state.tr.delete(end - 1, end)); // the x
    press(editor, "Enter");
    expect(items(editor)).toEqual(["list_item", "paragraph"]);
  });
});

describe("Tab and Shift-Tab", () => {
  test("Tab nests an item in the one before, with what's nested in it", async () => {
    const editor = await open("- one\n- two\n  - inner\n");
    cursor(editor, "two");
    expect(press(editor, "Tab")).toBe(true);
    expect(editor.save()).toBe("- one\n  - two\n    - inner\n");
    expect(editor.view.state.selection.$from.parent.textContent).toBe("two");
  });

  test("Tab nests a paragraph under the item before it", async () => {
    const editor = await open("- one\n\nText.\n");
    cursor(editor, "Text");
    press(editor, "Tab");
    expect(editor.save()).toBe("- one\n\n  Text.\n");
  });

  test("Tab with nothing to nest in: an item stays put, other text lets the key go", async () => {
    const editor = await open("- one\n");
    cursor(editor, "one");
    expect(press(editor, "Tab")).toBe(true);
    expect(editor.save()).toBeNull();
    const plain = await open("Text.\n");
    cursor(plain, "Text");
    expect(press(plain, "Tab")).toBe(false);
  });

  test("Shift-Tab takes the item out, and the items after it in its parent come along nested in it", async () => {
    const editor = await open("- one\n  - a\n  - b\n  - c\n");
    cursor(editor, "b");
    expect(press(editor, "Tab", { shiftKey: true })).toBe(true);
    expect(editor.save()).toBe("- one\n  - a\n- b\n  - c\n");
  });

  test("Shift-Tab takes a nested paragraph out", async () => {
    const editor = await open("- one\n\n  Text.\n");
    cursor(editor, "Text");
    press(editor, "Tab", { shiftKey: true });
    expect(editor.save()).toBe("- one\n\nText.\n");
  });
});

describe("Backspace at the start of an item", () => {
  test("turns it into text in place", async () => {
    const editor = await open("Intro.\n\n- one\n- two\n");
    cursor(editor, "two", { atStart: true });
    expect(press(editor, "Backspace")).toBe(true);
    expect(editor.save()).toBe("Intro.\n\n- one\n\ntwo\n");
    expect(editor.view.state.selection.$from.parentOffset).toBe(0);
  });

  test("a nested item stays nested, as text", async () => {
    const editor = await open("- one\n  - inner\n");
    cursor(editor, "inner", { atStart: true });
    press(editor, "Backspace");
    expect(editor.save()).toBe("- one\n\n  inner\n");
  });
});

test.each([
  ["- one\n\nText.\n", "- oneText.\n"],
  ["- one\n  - inner\n\nText.\n", "- one\n  - innerText.\n"],
  ["- one\n\n  Text.\n", "- oneText.\n"],
])("Backspace at the start of text after an item joins it to the item's line: %j", async (markdown, expected) => {
  const editor = await open(markdown);
  cursor(editor, "Text", { atStart: true });
  expect(press(editor, "Backspace")).toBe(true);
  expect(editor.save()).toBe(expected);
});

test("where a drop goes depends on how far right the pointer is", async () => {
  const editor = await open("- one\n  - inner\n");
  const { doc } = editor.view.state;
  let pos = -1;
  doc.descendants((n, p) => {
    if (n.isText && n.text === "inner") pos = p;
  });
  const targets = dropTargets(doc, blockAt(doc, pos)!, "after");
  // The top level, in "one" (whose text starts at 24) and nested in "inner" (at 48).
  const lefts = [0, 24, 48];
  const level = (x: number) => targets.indexOf(pickTarget(targets, lefts, x)!);
  expect(level(-10)).toBe(0); // left of everything: the top
  expect(level(10)).toBe(0);
  expect(level(30)).toBe(1); // over the text of "inner": after it
  expect(level(60)).toBe(1); // nesting takes going further into the text
  expect(level(100)).toBe(2);
});

describe("typing Markdown", () => {
  test.each([
    ["- ", "- x\n"],
    ["* ", "- x\n"],
    ["1. ", "1. x\n"],
    ["3. ", "3. x\n"],
    ["[ ] ", "- [ ] x\n"],
    ["[x] ", "- [x] x\n"],
  ])("%j starts a list item", async (marker, expected) => {
    const editor = await open("Intro.\n");
    editor.commands.continueAtEnd();
    type(editor, `${marker}x`);
    expect(editor.save()).toBe(`Intro.\n\n${expected}`);
  });

  test("\"[ ] \" on an item's line makes it a to-do; \"- \" stays text", async () => {
    const editor = await open("- \n");
    const { view } = editor;
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    type(editor, "[ ] x");
    expect(editor.save()).toBe("- [ ] x\n");
    const other = await open("- \n");
    other.view.dispatch(other.view.state.tr.setSelection(TextSelection.atEnd(other.view.state.doc)));
    type(other, "- x");
    expect(other.save()).toBe("- \\- x\n");
  });
});
