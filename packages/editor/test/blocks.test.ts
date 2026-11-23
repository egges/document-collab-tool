import { describe, expect, test } from "vitest";
import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import { type Block, type PageEditor, blockAt, createPageEditor, dropTarget, slashState } from "../src/index.ts";

const open = (markdown: string) => createPageEditor({ root: document.createElement("div"), markdown });

/** Document position inside the first text block containing `text`. */
function posOf(editor: PageEditor, text: string): number {
  let found = -1;
  editor.view.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text!.includes(text)) found = pos + node.text!.indexOf(text);
    return found < 0;
  });
  if (found < 0) throw new Error(`"${text}" not in document`);
  return found;
}

/** The block containing `text`. */
const block = (editor: PageEditor, text: string): Block => blockAt(editor.view.state.doc, posOf(editor, text))!;

function cursorIn(editor: PageEditor, text: string) {
  const { view } = editor;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, posOf(editor, text))));
}

function press(editor: PageEditor, key: string, mods: KeyboardEventInit = {}) {
  const { view } = editor;
  const event = new KeyboardEvent("keydown", { key, ...mods });
  return view.someProp("handleKeyDown", (f) => f(view, event)) ?? false;
}

const LIST = "- one\n- two\n- three\n";

describe("finding blocks", () => {
  test("top-level elements and list items are blocks", async () => {
    const editor = await open("# Title\n\nText.\n\n- one\n  - nested\n\n> quoted\n");
    expect(block(editor, "Title").node.type.name).toBe("heading");
    expect(block(editor, "Text").node.type.name).toBe("paragraph");
    expect(block(editor, "one").node.textContent).toBe("onenested");
    expect(block(editor, "nested").node.textContent).toBe("nested");
    expect(block(editor, "quoted").node.type.name).toBe("blockquote");
  });
});

describe("deleting", () => {
  test("a paragraph", async () => {
    const editor = await open("First.\n\nSecond.\n\nThird.\n");
    editor.commands.deleteBlock(block(editor, "Second"));
    expect(editor.save()).toBe("First.\n\nThird.\n");
  });

  test("a list item, and the list with its only item", async () => {
    const editor = await open(`Intro.\n\n${LIST}`);
    editor.commands.deleteBlock(block(editor, "two"));
    expect(editor.save()).toBe("Intro.\n\n- one\n- three\n");
    editor.commands.deleteBlock(block(editor, "one"));
    editor.commands.deleteBlock(block(editor, "three"));
    expect(editor.save()).toBe("Intro.\n");
  });

  test("the last block leaves an empty line", async () => {
    const editor = await open("Only.\n");
    editor.commands.deleteBlock(block(editor, "Only"));
    expect(editor.view.state.doc.childCount).toBe(1);
    expect(editor.view.state.doc.textContent).toBe("");
  });
});

describe("duplicating", () => {
  test("a paragraph, with the cursor moving to the copy", async () => {
    const editor = await open("Copy me.\n\nAfter.\n");
    cursorIn(editor, "me");
    const before = editor.view.state.selection.from;
    editor.commands.duplicateBlock(block(editor, "Copy"));
    expect(editor.save()).toBe("Copy me.\n\nCopy me.\n\nAfter.\n");
    expect(editor.view.state.selection.from).toBe(before + block(editor, "Copy").node.nodeSize);
  });

  test("a list item", async () => {
    const editor = await open(LIST);
    editor.commands.duplicateBlock(block(editor, "two"));
    expect(editor.save()).toBe("- one\n- two\n- two\n- three\n");
  });
});

describe("moving a step", () => {
  test("paragraphs swap with their neighbours", async () => {
    const editor = await open("A.\n\nB.\n\nC.\n");
    expect(editor.commands.moveBlock(block(editor, "B"), -1)).toBe(true);
    expect(editor.save()).toBe("B.\n\nA.\n\nC.\n");
    expect(editor.commands.moveBlock(block(editor, "B"), 1)).toBe(true);
    expect(editor.commands.moveBlock(block(editor, "B"), 1)).toBe(true);
    expect(editor.save()).toBe("A.\n\nC.\n\nB.\n");
    expect(editor.commands.moveBlock(block(editor, "B"), 1)).toBe(false);
  });

  test("list items move within their list", async () => {
    const editor = await open(`${LIST}\nAfter.\n`);
    editor.commands.moveBlock(block(editor, "three"), -1);
    expect(editor.save()).toBe("- one\n- three\n- two\n\nAfter.\n");
    expect(editor.commands.moveBlock(block(editor, "one"), -1)).toBe(false);
  });

  test("the selection moves with the block", async () => {
    const editor = await open("A.\n\nBlock B.\n");
    cursorIn(editor, "B.");
    editor.commands.moveBlock(block(editor, "Block"), -1);
    const { $from } = editor.view.state.selection;
    expect($from.parent.textContent).toBe("Block B.");
    expect($from.parentOffset).toBe(6);
  });
});

describe("moving by dragging", () => {
  const drop = (editor: PageEditor, dragged: string, over: string, side: "before" | "after") => {
    const target = dropTarget(editor.view.state.doc, block(editor, dragged), block(editor, over), side);
    return target && editor.commands.moveBlockTo(block(editor, dragged), target.pos);
  };

  test("a paragraph, before or after another", async () => {
    const editor = await open("A.\n\nB.\n\nC.\n");
    drop(editor, "A", "C", "after");
    expect(editor.save()).toBe("B.\n\nC.\n\nA.\n");
    drop(editor, "A", "B", "before");
    expect(editor.save()).toBeNull(); // back where it was
    expect(editor.view.state.selection).toBeInstanceOf(NodeSelection);
  });

  test("dropping a block next to itself does nothing", async () => {
    const editor = await open("A.\n\nB.\n");
    expect(drop(editor, "A", "A", "after")).toBeNull();
    expect(drop(editor, "A", "B", "before")).toBeNull();
    expect(editor.save()).toBeNull();
  });

  test("a list item out of its list becomes a list of its own", async () => {
    const editor = await open(`Intro.\n\n${LIST}`);
    drop(editor, "two", "Intro", "before");
    expect(editor.save()).toBe("- two\n\nIntro.\n\n- one\n- three\n");
  });

  test("a paragraph dropped into a list becomes an item, and a to-do next to to-dos", async () => {
    const editor = await open(`Loose.\n\n${LIST}`);
    drop(editor, "Loose", "two", "after");
    expect(editor.save()).toBe("- one\n- two\n- Loose.\n- three\n");

    const tasks = await open("Loose.\n\n- [ ] first\n- [x] second\n");
    drop(tasks, "Loose", "first", "after");
    expect(tasks.save()).toBe("- [ ] first\n- [ ] Loose.\n- [x] second\n");
  });

  test("a heading can't be a list item, so it goes next to the list", async () => {
    const editor = await open(`# Head\n\n${LIST}`);
    // The line is drawn where it will land: after the list, not after the item.
    const target = dropTarget(editor.view.state.doc, block(editor, "Head"), block(editor, "three"), "after")!;
    expect(target.block.node.type.name).toBe("bullet_list");
    expect(target.side).toBe("after");
    drop(editor, "Head", "three", "after");
    expect(editor.save()).toBe("- one\n- two\n- three\n\n# Head\n");
  });

  test("the only item of a list takes its list along", async () => {
    const editor = await open("- alone\n\nA.\n\nB.\n");
    drop(editor, "alone", "B", "after");
    expect(editor.save()).toBe("A.\n\nB.\n\n- alone\n");
  });

  test("an item into a nested list", async () => {
    const editor = await open("- one\n  - inner\n- two\n");
    drop(editor, "two", "inner", "after");
    expect(editor.save()).toBe("- one\n  - inner\n  - two\n");
  });
});

describe("adding a block", () => {
  test("below, starting with / so the block menu opens", async () => {
    const editor = await open("A.\n\nB.\n");
    editor.commands.insertBlock(block(editor, "A"), { text: "/" });
    expect(slashState(editor.view.state)).toMatchObject({ query: "" });
    editor.commands.runSlash("heading2");
    editor.view.dispatch(editor.view.state.tr.insertText("New"));
    expect(editor.save()).toBe("A.\n\n## New\n\nB.\n");
  });

  test("above", async () => {
    const editor = await open("A.\n");
    editor.commands.insertBlock(block(editor, "A"), { above: true });
    editor.view.dispatch(editor.view.state.tr.insertText("Z."));
    expect(editor.save()).toBe("Z.\n\nA.\n");
  });

  test("in a list, a new item; next to a to-do, an unticked to-do", async () => {
    const editor = await open("- [x] done\n");
    editor.commands.insertBlock(block(editor, "done"));
    editor.view.dispatch(editor.view.state.tr.insertText("next"));
    expect(editor.save()).toBe("- [x] done\n- [ ] next\n");
  });

  test("an empty line is reused", async () => {
    const editor = await open("A.\n\nB.\n");
    editor.commands.insertBlock(block(editor, "A"));
    const blocks = editor.view.state.doc.childCount;
    editor.commands.insertBlock(blockAt(editor.view.state.doc, editor.view.state.selection.from)!, { text: "/" });
    expect(editor.view.state.doc.childCount).toBe(blocks);
  });
});

describe("clicking below the last block", () => {
  test("adds a paragraph at the end and puts the cursor in it", async () => {
    const editor = await open("# Title\n\n- item\n");
    editor.commands.continueAtEnd();
    editor.view.dispatch(editor.view.state.tr.insertText("More."));
    expect(editor.save()).toBe("# Title\n\n- item\n\nMore.\n");
  });

  test("after a code block or a table too", async () => {
    const editor = await open("```\ncode\n```\n");
    editor.commands.continueAtEnd();
    editor.view.dispatch(editor.view.state.tr.insertText("After."));
    expect(editor.save()).toBe("```\ncode\n```\n\nAfter.\n");
  });

  test("an empty last paragraph is reused, so clicking again adds nothing", async () => {
    const editor = await open("A.\n");
    editor.commands.continueAtEnd();
    const blocks = editor.view.state.doc.childCount;
    editor.commands.continueAtEnd();
    expect(editor.view.state.doc.childCount).toBe(blocks);
    expect(editor.save()).toBeNull(); // an empty paragraph at the end doesn't change the file
  });
});

describe("turning into", () => {
  test.each([
    ["- one\n- two\n", "two", "text", "- one\n\ntwo\n"],
    ["- one\n- two\n", "two", "heading2", "- one\n\n## two\n"],
    ["- one\n- two\n", "two", "numberedList", "1. one\n2. two\n"],
    ["- one\n- two\n", "two", "taskList", "- one\n- [ ] two\n"],
    ["- [x] one\n", "one", "bulletList", "- one\n"],
    ["1. one\n", "one", "taskList", "1. [ ] one\n"],
    ["> quoted\n", "quoted", "heading1", "# quoted\n"],
    ["> quoted\n", "quoted", "bulletList", "> - quoted\n"],
    ["Plain.\n", "Plain", "quote", "> Plain.\n"],
  ] as const)("%j: %s → %s", async (markdown, text, format, expected) => {
    const editor = await open(markdown);
    expect(editor.commands.turnBlockInto(block(editor, text), format)).toBe(true);
    expect(editor.save()).toBe(expected);
  });
});

describe("keys", () => {
  test("Esc selects the block; Backspace then deletes it", async () => {
    const editor = await open("A.\n\nB.\n");
    cursorIn(editor, "B");
    expect(press(editor, "Escape")).toBe(true);
    expect(editor.view.state.selection).toBeInstanceOf(NodeSelection);
    expect(press(editor, "Backspace")).toBe(true);
    expect(editor.save()).toBe("A.\n");
  });

  test("Esc on a list item selects the item, and Enter goes back to its text", async () => {
    const editor = await open(LIST);
    cursorIn(editor, "two");
    press(editor, "Escape");
    expect((editor.view.state.selection as NodeSelection).node.type.name).toBe("list_item");
    press(editor, "Enter");
    expect(editor.view.state.selection).toBeInstanceOf(TextSelection);
    expect(editor.view.state.selection.$from.parent.textContent).toBe("two");
    expect(editor.save()).toBeNull();
    press(editor, "Escape");
    press(editor, "Delete");
    expect(editor.save()).toBe("- one\n- three\n");
  });

  test("⌘D duplicates and ⌘⇧↑ / ⌘⇧↓ move", async () => {
    const editor = await open("A.\n\nB.\n");
    cursorIn(editor, "B");
    expect(press(editor, "d", { ctrlKey: true })).toBe(true);
    expect(editor.save()).toBe("A.\n\nB.\n\nB.\n");
    press(editor, "ArrowUp", { ctrlKey: true, shiftKey: true });
    press(editor, "ArrowUp", { ctrlKey: true, shiftKey: true });
    expect(editor.save()).toBe("B.\n\nA.\n\nB.\n");
    // At the top: nothing to do, but the key is still taken.
    expect(press(editor, "ArrowUp", { ctrlKey: true, shiftKey: true })).toBe(true);
    press(editor, "ArrowDown", { ctrlKey: true, shiftKey: true });
    expect(editor.save()).toBe("A.\n\nB.\n\nB.\n");
  });
});

test("a block as Markdown, for copying", async () => {
  const editor = await open("## Head\n\n1. one\n2. two\n\n- [x] done\n");
  expect(editor.commands.blockMarkdown(block(editor, "Head"))).toBe("## Head");
  expect(editor.commands.blockMarkdown(block(editor, "two"))).toMatch(/^\d\. two$/);
  expect(editor.commands.blockMarkdown(block(editor, "done"))).toBe("- [x] done");
});
