import { describe, expect, test } from "vitest";
import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import { type Block, type PageEditor, blockAt, createPageEditor, dropTargets, slashState } from "../src/index.ts";

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
  test("top-level elements, list items and what's nested in them are blocks", async () => {
    const editor = await open("# Title\n\nText.\n\n- one\n  - nested\n\n> quoted\n");
    expect(block(editor, "Title").node.type.name).toBe("heading");
    expect(block(editor, "Text").node.type.name).toBe("paragraph");
    expect(block(editor, "one").node.textContent).toBe("onenested");
    expect(block(editor, "nested").node.textContent).toBe("nested");
    expect(block(editor, "quoted").node.type.name).toBe("blockquote");

    const nested = await open("- item\n\n  More text.\n");
    expect(block(nested, "item").node.type.name).toBe("list_item");
    expect(block(nested, "More").node.type.name).toBe("paragraph");
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
  /** Drops `dragged` on the `side` half of `over`'s line, at `level` of the places offered (the top level is 0; by default the deepest). */
  const drop = (editor: PageEditor, dragged: string, over: string, side: "before" | "after", level?: number) => {
    const targets = dropTargets(editor.view.state.doc, block(editor, over), side, block(editor, dragged));
    const target = level === undefined ? targets.at(-1) : targets[level];
    return target ? editor.commands.moveBlockTo(block(editor, dragged), target.pos) : null;
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
    expect(drop(editor, "A", "A", "after")).toBe(false);
    expect(drop(editor, "A", "B", "before")).toBe(false);
    expect(editor.save()).toBeNull();
  });

  test("a list item moved away from its list stays an item", async () => {
    const editor = await open(`Intro.\n\n${LIST}`);
    drop(editor, "two", "Intro", "before");
    expect(editor.save()).toBe("- two\n\nIntro.\n\n- one\n- three\n");
  });

  test("a paragraph dropped between items stays a paragraph, or is nested in the item above", async () => {
    const editor = await open(`Loose.\n\n${LIST}`);
    drop(editor, "Loose", "two", "after", 0);
    expect(editor.save()).toBe("- one\n- two\n\nLoose.\n\n- three\n");

    const nested = await open(`Loose.\n\n${LIST}`);
    drop(nested, "Loose", "two", "after", 1);
    expect(nested.save()).toBe("- one\n- two\n\n  Loose.\n- three\n");
  });

  test("below the last item nested in a list, each level it closes is a place", async () => {
    const editor = await open("- one\n  - inner\n- two\n\nAfter.\n");
    const targets = dropTargets(editor.view.state.doc, block(editor, "inner"), "after");
    expect(targets.map((t) => t.parent?.node.firstChild?.textContent ?? "top")).toEqual(["top", "one", "inner"]);
    drop(editor, "After", "inner", "after", 0);
    expect(editor.save()).toBe("- one\n  - inner\n\nAfter.\n\n- two\n");
  });

  test("an item into a nested list", async () => {
    const editor = await open("- one\n  - inner\n- two\n");
    drop(editor, "two", "inner", "after", 1);
    expect(editor.save()).toBe("- one\n  - inner\n  - two\n");
  });

  test("below the line of an item with nested blocks, only nested first", async () => {
    const editor = await open("- one\n  - inner\n\nNew.\n");
    const targets = dropTargets(editor.view.state.doc, block(editor, "one"), "after");
    expect(targets).toHaveLength(1);
    drop(editor, "New", "one", "after");
    expect(editor.save()).toBe("- one\n\n  New.\n  - inner\n");
  });

  test("the gap between two items offers the same places from either side of it", async () => {
    const editor = await open("- one\n- two\n");
    const { doc } = editor.view.state;
    const places = (over: string, side: "before" | "after") =>
      dropTargets(doc, block(editor, over), side).map((t) => [t.pos, t.parent?.pos ?? null]);
    expect(places("two", "before")).toEqual(places("one", "after"));
    expect(places("two", "before")).toHaveLength(2); // after "one", or nested in it
  });

  test("a block nested in an item can be dragged out of it from over itself", async () => {
    const editor = await open("- text\n\n  ![](a.png)\n\nAfter.\n");
    const { doc } = editor.view.state;
    let imagePos = -1;
    doc.descendants((n, p) => {
      if (n.type.name === "image") imagePos = p;
    });
    const image = blockAt(doc, imagePos)!;
    expect(image.node.type.name).toBe("paragraph");
    // Over the top half of the image itself: the top level is offered too.
    const targets = dropTargets(doc, image, "before", image);
    expect(targets.map((t) => t.parent?.node.firstChild?.textContent ?? "top")).toEqual(["top", "text"]);
    editor.commands.moveBlockTo(image, targets[0].pos);
    expect(editor.save()).toBe("- text\n\n![](a.png)\n\nAfter.\n");
  });

  test("not into itself", async () => {
    const editor = await open("- one\n  - inner\n");
    const targets = dropTargets(editor.view.state.doc, block(editor, "inner"), "after", block(editor, "one"));
    expect(targets.map((t) => t.parent)).toEqual([null]); // only right after it, where it is
    expect(drop(editor, "one", "inner", "after")).toBe(false);
  });

  // Found by dragging.test.ts: in a tight item these read back as part of the block above.
  test("a table, rule or paragraph nested in a tight item is saved apart from what's above it", async () => {
    const table = await open("| a | b |\n| - | - |\n| c | d |\n\n- one\n  - inner\n");
    drop(table, "a", "inner", "after", 1);
    expect(table.save()).toBe("- one\n  - inner\n\n  | a | b |\n  | - | - |\n  | c | d |\n");

    const rule = await open("---\n\n- one\n- two\n");
    const hr = blockAt(rule.view.state.doc, 0)!;
    rule.commands.moveBlockTo(hr, dropTargets(rule.view.state.doc, block(rule, "one"), "after", hr).at(-1)!.pos);
    expect(rule.save()).toBe("- one\n\n  ---\n- two\n");

    const paragraph = await open("Text.\n\n- one\n  - inner\n");
    drop(paragraph, "Text", "inner", "after", 1);
    expect(paragraph.save()).toBe("- one\n  - inner\n\n  Text.\n");
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
    ["- one\n- two\n", "two", "numberedList", "- one\n\n1. two\n"],
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
