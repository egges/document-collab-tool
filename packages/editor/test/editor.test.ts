import { describe, expect, test } from "vitest";
import { Editor, parserCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import {
  SaveRefusedError,
  blockAt,
  createPageEditor,
  findLostContent,
  formatPage,
  joinPage,
  splitFrontMatter,
} from "../src/index.ts";
import { editOneWord } from "./helpers.ts";

const open = (markdown: string, onDirtyChange?: (dirty: boolean) => void) =>
  createPageEditor({ root: document.createElement("div"), markdown, onDirtyChange });

describe("saving", () => {
  test("an edit makes the page dirty, and markSaved makes it clean", async () => {
    const changes: boolean[] = [];
    const editor = await open("# Title\n\nSome words here.\n", (d) => changes.push(d));
    editOneWord(editor.view);
    expect(editor.dirty).toBe(true);
    expect(editor.save()).toBe("# Title\n\nSome EDITED here.\n");
    expect(editor.dirty).toBe(true); // not written yet
    editor.markSaved();
    expect(editor.dirty).toBe(false);
    expect(editor.save()).toBeNull();
    expect(changes).toEqual([true, false]);
    await editor.destroy();
  });

  test("markSaved records the saved version, not later edits", async () => {
    const editor = await open("First words here.\n");
    editOneWord(editor.view);
    editor.save();
    editor.view.dispatch(editor.view.state.tr.insertText(" More."));
    editor.markSaved();
    expect(editor.dirty).toBe(true);
    await editor.destroy();
  });

  test("undoing back to the saved version counts as unchanged", async () => {
    const editor = await open("Some words here.\n");
    const before = editor.view.state.doc;
    editOneWord(editor.view);
    editor.view.dispatch(editor.view.state.tr.replaceWith(0, editor.view.state.doc.content.size, before.content));
    expect(editor.dirty).toBe(false);
    expect(editor.save()).toBeNull();
    await editor.destroy();
  });

  test("empty lines are not saved, and an edit that only adds one saves nothing", async () => {
    const editor = await open("One.\n\nTwo words here.\n");
    const { view } = editor;
    const empty = () => view.state.schema.nodes.paragraph.create();
    view.dispatch(view.state.tr.insert(view.state.doc.firstChild!.nodeSize, empty()));
    expect(editor.dirty).toBe(true);
    expect(editor.save()).toBeNull(); // same bytes as on disk
    editOneWord(editor.view);
    expect(editor.save()).toBe("One.\n\nTwo EDITED here.\n");
    await editor.destroy();
  });

  test("load replaces the page and resets the baseline", async () => {
    const editor = await open("Old words here.\n");
    editOneWord(editor.view);
    editor.load("# Newer version\n\nPulled from another device.\n");
    expect(editor.dirty).toBe(false);
    expect(editor.view.state.doc.textContent).toContain("Pulled from another device.");
    await editor.destroy();
  });

  test("front matter is kept unchanged through an edit", async () => {
    const markdown = "---\ntitle: Imported\ntags: [a, b]\n---\n\n# Page\n\nBody words here.\n";
    const editor = await open(markdown);
    editOneWord(editor.view);
    expect(editor.save()).toBe("---\ntitle: Imported\ntags: [a, b]\n---\n\n# Page\n\nBody EDITED here.\n");
    await editor.destroy();
  });
});

describe("file format", () => {
  test("pages end in exactly one newline", () => {
    expect(joinPage("", "text")).toBe("text\n");
    expect(joinPage("", "text\n\n\n")).toBe("text\n");
    expect(joinPage("", "")).toBe("");
    expect(joinPage("---\na: 1\n---\n", "")).toBe("---\na: 1\n---\n");
  });

  test("front matter is only recognised at the very top", () => {
    expect(splitFrontMatter("text\n---\na: 1\n---\n").frontMatter).toBe("");
    expect(splitFrontMatter("---\na: 1\n---\nbody\n")).toEqual({ frontMatter: "---\na: 1\n---\n", body: "body\n" });
  });

  test("a rule at the top of a page isn't saved as front matter", async () => {
    const editor = await open("Text.\n\n---\n\nMore.\n\n---\n");
    const first = blockAt(editor.view.state.doc, 1)!;
    editor.commands.moveBlockTo(first, editor.view.state.doc.content.size);
    const saved = editor.save()!;
    expect(saved).toBe("***\n\nMore.\n\n---\n\nText.\n");
    expect(splitFrontMatter(saved).frontMatter).toBe("");
    await editor.destroy();
  });

  test("house style: dash bullets and rules, unpadded tables", async () => {
    expect(await formatPage("* a\n* b\n\n***\n\n| x | long header |\n|-|-|\n| 1 | 2 |\n"))
      .toBe("- a\n- b\n\n---\n\n| x | long header |\n| - | - |\n| 1 | 2 |\n");
  });
});

describe("safety check", () => {
  test("reports content that would be lost", async () => {
    const editor = await Editor.make()
      .config((ctx) => ctx.set(rootCtx, document.createElement("div")))
      .use(commonmark)
      .use(gfm)
      .create();
    const parse = editor.action((ctx) => ctx.get(parserCtx));

    expect(findLostContent(parse("Same text."), parse("Same text."))).toBeNull();
    // Formatting changes are not content loss.
    expect(findLostContent(parse("Some *text*."), parse("Some **text**."))).toBeNull();
    // A paragraph read back as a numbered list (the escaping bug Tiptap had).
    expect(findLostContent(parse("1986\\. A great year"), parse("1986. A great year")))
      .toMatch(/expected "paragraph: 1986\. A great year"/);
    // A raw HTML element that would be dropped.
    expect(findLostContent(parse("Press <kbd>x</kbd>"), parse("Press x"))).not.toBeNull();
    // A missing image.
    expect(findLostContent(parse("![a](a.png)"), parse(""))).not.toBeNull();

    expect(new SaveRefusedError("detail").message).toContain("detail");
    await editor.destroy();
  });
});
