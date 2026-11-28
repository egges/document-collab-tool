import { describe, expect, test } from "vitest";
import { TextSelection } from "@milkdown/kit/prose/state";
import {
  type PageEditor,
  blockAt,
  createPageEditor,
  dropTargets,
  formatState,
  isFolded,
  placeholderAt,
  setFolded,
} from "../src/index.ts";
import { editOneWord, render } from "./helpers.ts";

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

const toggle = (title: string, body: string, level = 2) =>
  `<details>\n<summary><h${level}>${title}</h${level}></summary>\n\n${body}\n\n</details>\n`;

/** Positions of the toggles in the page, in order. */
function toggles(editor: PageEditor): number[] {
  const found: number[] = [];
  editor.view.state.doc.descendants((node, pos) => {
    if (node.type.name === "toggle") found.push(pos);
    return true;
  });
  return found;
}

const folded = (editor: PageEditor) => toggles(editor).map((pos) => isFolded(editor.view.state, pos));

describe("toggles in Markdown", () => {
  test("a <details> with a heading for its summary is read as a toggle", async () => {
    const editor = await open(toggle("Agent steps", "Read 14 emails.\n\n- drafted 3 replies"));
    const node = editor.view.state.doc.firstChild!;
    expect(node.type.name).toBe("toggle");
    expect(node.firstChild!.type.name).toBe("heading");
    expect(node.firstChild!.attrs.level).toBe(2);
    expect(node.firstChild!.textContent).toBe("Agent steps");
    expect(node.childCount).toBe(3);
  });

  test("and written back unchanged", async () => {
    const pages = [
      toggle("Title", "Body."),
      toggle("One", "Text.", 1) + "\n" + toggle("Three", "Text.", 3),
      toggle("Outer", toggle("Inner", "Deep.").trimEnd()),
      toggle("Has a list", "- one\n- two\n\n1. first"),
      toggle("<strong>Bold</strong> and <em>italic</em>, <code>code</code>", "Text."),
      toggle('A <a href="https://example.com/?a=1&amp;b=2">link</a> &amp; &lt;tags&gt;', "Text."),
      "<details>\n<summary><h2>Empty</h2></summary>\n\n</details>\n",
      "- item\n\n  <details>\n  <summary><h2>In a list</h2></summary>\n\n  Nested.\n\n  </details>\n",
      "> <details>\n> <summary><h3>In a quote</h3></summary>\n>\n> Quoted.\n>\n> </details>\n",
    ];
    for (const page of pages) {
      const editor = await open(`Some words here.\n\n${page}`);
      editOneWord(editor.view);
      expect(editor.save()).toBe(`Some EDITED here.\n\n${page}`);
    }
  });

  test("GitHub shows what was written as a details element", async () => {
    const editor = await open("Some words here.\n");
    cursor(editor, "here.");
    editor.commands.setBlock("toggleHeading2");
    press(editor, "Enter");
    editor.view.dispatch(editor.view.state.tr.insertText("Inside."));
    expect(render(editor.save()!)).toBe("<details><summary><h2>Some words here.</h2></summary><p>Inside.</p></details>");
  });

  test("other <details> stay raw HTML", async () => {
    const pages = [
      "<details>\n<summary><p>A block in the summary</p></summary>\n\nBody.\n\n</details>\n",
      "<details>\n<summary><h2>No end</h2></summary>\n\nBody.\n",
      "<details>\n<summary>No blank line</summary>\nBody.\n</details>\n",
    ];
    for (const page of pages) {
      const editor = await open(`Some words here.\n\n${page}`);
      expect(toggles(editor)).toEqual([]);
      editOneWord(editor.view);
      expect(editor.save()).toBe(`Some EDITED here.\n\n${page}`);
    }
  });

  test("an `open` attribute is read, and left out when saved", async () => {
    const editor = await open("<details open>\n<summary><h2>Title</h2></summary>\n\nBody.\n\n</details>\n");
    expect(toggles(editor)).toHaveLength(1);
  });

  test("a title's HTML never runs", async () => {
    const before = document.body.innerHTML;
    const editor = await open(toggle('<img src="x" onerror="window.hacked = true">Title', "Body."));
    expect(editor.view.state.doc.firstChild!.firstChild!.textContent).toBe("Title");
    expect((window as { hacked?: boolean }).hacked).toBeUndefined();
    expect(document.body.innerHTML).toBe(before);
  });
});

describe("open and closed", () => {
  test("toggles start closed when a page opens", async () => {
    const editor = await open(toggle("One", "A.") + "\n" + toggle("Two", "B."));
    expect(folded(editor)).toEqual([true, true]);
  });

  test("⌘Enter on the heading opens and closes it", async () => {
    const editor = await open(toggle("Title", "Body."));
    cursor(editor, "Title");
    press(editor, "Enter", { ctrlKey: true });
    expect(folded(editor)).toEqual([false]);
    press(editor, "Enter", { ctrlKey: true });
    expect(folded(editor)).toEqual([true]);
  });

  test("closing takes the cursor out of what it hides", async () => {
    const editor = await open(toggle("Title", "Body."));
    const [pos] = toggles(editor);
    cursor(editor, "Body.");
    expect(folded(editor)).toEqual([false]);
    editor.view.dispatch(setFolded(editor.view.state, pos, true));
    expect(folded(editor)).toEqual([true]);
    expect(editor.view.state.selection.$from.parent.textContent).toBe("Title");
  });

  test("the cursor going into a closed toggle opens it, and the ones around it", async () => {
    const editor = await open(toggle("Outer", toggle("Inner", "Deep.").trimEnd()));
    cursor(editor, "Deep.");
    expect(folded(editor)).toEqual([false, false]);
  });

  test("being open isn't saved, and doesn't change the page", async () => {
    const editor = await open(toggle("Title", "Body."));
    editor.view.dispatch(setFolded(editor.view.state, toggles(editor)[0], false));
    expect(editor.dirty).toBe(false);
    expect(editor.save()).toBeNull();
  });

  test("moving a toggle keeps it closed or open", async () => {
    const editor = await open(`First.\n\n${toggle("Closed", "A.")}\n${toggle("Open", "B.")}`);
    const [closed, opened] = toggles(editor);
    editor.view.dispatch(setFolded(editor.view.state, opened, false));
    // Dragged to the top.
    editor.commands.moveBlockTo(editor.commands.blockAt(closed + 2)!, 0);
    expect(folded(editor)).toEqual([true, false]);
    // One step down, both of them.
    for (const pos of toggles(editor)) editor.commands.moveBlock(editor.commands.blockAt(pos + 2)!, 1);
    expect(editor.view.state.doc.firstChild!.textContent).toBe("First.");
    expect(folded(editor)).toEqual([true, false]);
  });

  test("Tab and Shift-Tab keep a toggle closed, and the closed toggles in a moved one", async () => {
    const editor = await open(`- item\n\n${toggle("Outer", toggle("Inner", "Deep.").trimEnd())}`);
    cursor(editor, "Outer");
    press(editor, "Tab");
    expect(folded(editor)).toEqual([true, true]);
    press(editor, "Tab", { shiftKey: true });
    expect(folded(editor)).toEqual([true, true]);
  });

  test("a closed toggle offers no place inside it to drop a block", async () => {
    const editor = await open(toggle("Title", "Body.") + "\nAfter.\n");
    const { state } = editor.view;
    const [pos] = toggles(editor);
    const over = blockAt(state.doc, pos + 2)!;
    const isClosed = (p: number) => isFolded(editor.view.state, p);
    expect(dropTargets(state.doc, over, "after", undefined, isClosed).map((t) => t.parent?.pos ?? null)).toEqual([null]);
    // Below "After.", the line above is the closed toggle, not the hidden block in it.
    const after = blockAt(state.doc, state.doc.content.size - 2)!;
    expect(dropTargets(state.doc, after, "before", undefined, isClosed).map((t) => t.pos)).toEqual([after.pos]);
    editor.view.dispatch(setFolded(state, pos, false));
    const opened = dropTargets(editor.view.state.doc, over, "after", undefined, isClosed);
    expect(opened.map((t) => t.parent?.pos ?? null)).toEqual([pos]);
  });
});

describe("making toggle headings", () => {
  test("turning text into a toggle heading, which starts open", async () => {
    const editor = await open("Title\n\nAfter.\n");
    cursor(editor, "Title");
    expect(editor.commands.setBlock("toggleHeading1")).toBe(true);
    expect(formatState(editor.view.state).block).toBe("toggleHeading1");
    expect(folded(editor)).toEqual([false]);
    expect(editor.save()).toBe("<details>\n<summary><h1>Title</h1></summary>\n\n</details>\n\nAfter.\n");
  });

  test("a heading and a list item become toggle headings too", async () => {
    const editor = await open("## Heading\n\n- item\n");
    cursor(editor, "Heading");
    editor.commands.setBlock("toggleHeading2");
    cursor(editor, "item");
    editor.commands.setBlock("toggleHeading3");
    expect(editor.save()).toBe(
      "<details>\n<summary><h2>Heading</h2></summary>\n\n</details>\n\n<details>\n<summary><h3>item</h3></summary>\n\n</details>\n",
    );
  });

  test("another toggle heading level keeps it a toggle", async () => {
    const editor = await open(toggle("Title", "Body."));
    cursor(editor, "Title");
    editor.commands.setBlock("toggleHeading3");
    expect(editor.save()).toBe(toggle("Title", "Body.", 3));
  });

  test("turning a toggle into anything else keeps what's in it, in place", async () => {
    const editor = await open(toggle("Title", "Body."));
    cursor(editor, "Title");
    editor.commands.setBlock("heading2");
    expect(editor.save()).toBe("## Title\n\nBody.\n");
    editor.load(toggle("Title", "Body."));
    cursor(editor, "Title");
    editor.commands.setBlock("bulletList");
    expect(editor.save()).toBe("- Title\n\nBody.\n");
  });

  test("an empty toggle heading says what it is", async () => {
    const editor = await open("Text.\n");
    cursor(editor, "Text.");
    editor.commands.setBlock("toggleHeading2");
    editor.view.dispatch(editor.view.state.tr.delete(editor.view.state.selection.$from.start(), editor.view.state.selection.from));
    expect(placeholderAt(editor.view.state, true)?.text).toBe("Toggle heading 2");
  });
});

describe("keys", () => {
  test("Enter at the end of an open toggle's heading adds its first block", async () => {
    const editor = await open(toggle("Title", "Body."));
    editor.view.dispatch(setFolded(editor.view.state, toggles(editor)[0], false));
    cursor(editor, "Title");
    press(editor, "Enter");
    editor.view.dispatch(editor.view.state.tr.insertText("First."));
    expect(editor.save()).toBe(toggle("Title", "First.\n\nBody."));
  });

  test("on a closed one, a block after it", async () => {
    const editor = await open(toggle("Title", "Body."));
    cursor(editor, "Title");
    press(editor, "Enter");
    editor.view.dispatch(editor.view.state.tr.insertText("After."));
    expect(editor.save()).toBe(`${toggle("Title", "Body.")}\nAfter.\n`);
    expect(folded(editor)).toEqual([true]);
  });

  test("in the middle, the rest of the heading moves to its first block, opening it", async () => {
    const editor = await open(toggle("TitleRest", "Body."));
    cursor(editor, "Title");
    press(editor, "Enter");
    expect(editor.save()).toBe(toggle("Title", "Rest\n\nBody."));
    expect(folded(editor)).toEqual([false]);
  });

  test("at the start, an empty block goes above", async () => {
    const editor = await open(toggle("Title", "Body."));
    cursor(editor, "Title", { atStart: true });
    press(editor, "Enter");
    expect(editor.view.state.doc.firstChild!.type.name).toBe("paragraph");
    expect(editor.view.state.selection.$from.parent.textContent).toBe("Title");
  });

  test("Backspace at the start makes it a plain heading, its blocks staying where they are", async () => {
    const editor = await open(toggle("Title", "Body."));
    cursor(editor, "Title", { atStart: true });
    press(editor, "Backspace");
    expect(editor.save()).toBe("## Title\n\nBody.\n");
  });

  test("Tab puts a block into the toggle before it, Shift-Tab takes it out", async () => {
    const editor = await open(`${toggle("Title", "Body.")}\nAfter.\n`);
    cursor(editor, "After.");
    press(editor, "Tab");
    expect(editor.save()).toBe(toggle("Title", "Body.\n\nAfter."));
    expect(folded(editor)).toEqual([false]);
    editor.markSaved();
    press(editor, "Tab", { shiftKey: true });
    expect(editor.save()).toBe(`${toggle("Title", "Body.")}\nAfter.\n`);
  });
});

describe("toggle lists", () => {
  const list = (title: string, body: string) => `<details>\n<summary>${title}</summary>\n\n${body}\n\n</details>\n`;

  test("a <details> with text for its summary is a toggle whose line is text", async () => {
    const editor = await open(list("Agent <em>steps</em>", "Read 14 emails."));
    const node = editor.view.state.doc.firstChild!;
    expect(node.type.name).toBe("toggle");
    expect(node.firstChild!.type.name).toBe("paragraph");
    expect(node.firstChild!.textContent).toBe("Agent steps");
    expect(folded(editor)).toEqual([true]);
  });

  test("and written back unchanged", async () => {
    const pages = [
      list("Title", "Body."),
      list("<strong>Bold</strong> &amp; more", list("Inner", "Deep.").trimEnd()),
      "<details>\n<summary></summary>\n\n</details>\n",
      list("&#32;&#32;Starts with spaces", "Body."),
      "- item\n\n  <details>\n  <summary>In a list</summary>\n\n  Nested.\n\n  </details>\n",
    ];
    for (const page of pages) {
      const editor = await open(`Some words here.\n\n${page}`);
      editOneWord(editor.view);
      expect(editor.save()).toBe(`Some EDITED here.\n\n${page}`);
    }
  });

  test("turning text into a toggle list, and a toggle list into a toggle heading and back", async () => {
    const editor = await open("Title\n");
    cursor(editor, "Title");
    editor.commands.setBlock("toggle");
    expect(formatState(editor.view.state).block).toBe("toggle");
    expect(folded(editor)).toEqual([false]);
    expect(editor.save()).toBe("<details>\n<summary>Title</summary>\n\n</details>\n");
    editor.commands.setBlock("toggleHeading2");
    expect(editor.save()).toBe("<details>\n<summary><h2>Title</h2></summary>\n\n</details>\n");
    editor.commands.setBlock("toggle");
    expect(editor.save()).toBe("<details>\n<summary>Title</summary>\n\n</details>\n");
    editor.commands.setBlock("text");
    expect(editor.save()).toBeNull(); // the page as it was opened
    expect(editor.view.state.doc.firstChild!.type.name).toBe("paragraph");
  });

  test("Enter at the end of a closed toggle list adds another toggle after it", async () => {
    const editor = await open(list("One", "A."));
    cursor(editor, "One");
    press(editor, "Enter");
    editor.view.dispatch(editor.view.state.tr.insertText("Two"));
    expect(editor.save()).toBe(`${list("One", "A.")}\n${list("Two", "").replace("\n\n\n", "\n")}`);
    expect(folded(editor)).toEqual([true, false]);
  });

  test("Enter on an empty toggle list with nothing in it makes it text", async () => {
    const editor = await open("Text.\n");
    cursor(editor, "Text.");
    editor.commands.setBlock("toggle");
    const { $from } = editor.view.state.selection;
    editor.view.dispatch(editor.view.state.tr.delete($from.start(), $from.pos));
    expect(placeholderAt(editor.view.state, true)?.text).toBe("Toggle");
    press(editor, "Enter");
    expect(editor.view.state.doc.firstChild!.type.name).toBe("paragraph");
  });

  test("Backspace at the start makes it text, its blocks staying where they are", async () => {
    const editor = await open(list("Title", "Body."));
    cursor(editor, "Title", { atStart: true });
    press(editor, "Backspace");
    expect(editor.save()).toBe("Title\n\nBody.\n");
  });
});
