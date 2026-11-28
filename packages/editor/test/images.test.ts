import { describe, expect, test } from "vitest";
import { createPageEditor, insertImages } from "../src/index.ts";

const open = (markdown: string, addImage?: (file: File) => Promise<string>) =>
  createPageEditor({
    root: document.createElement("div"),
    markdown,
    imageSrc: (src) => `page-asset://page/${src}`,
    addImage,
  });

const png = (name = "image.png") => new File(["x"], name, { type: "image/png" });

describe("images", () => {
  test("are drawn from the address the app gives", async () => {
    const editor = await open("![A diagram](assets/diagram.png)\n");
    const img = editor.view.dom.querySelector<HTMLImageElement>("img[src]")!;
    expect(img.getAttribute("src")).toBe("page-asset://page/assets/diagram.png");
    expect(img.alt).toBe("A diagram");
    expect(editor.save()).toBeNull(); // opening doesn't rewrite the link
    await editor.destroy();
  });

  test("added in an empty paragraph take its place, each in its own paragraph", async () => {
    const editor = await open("Intro.\n");
    const { view } = editor;
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, view.state.schema.nodes.paragraph.create()));
    const names: string[] = [];
    const add = async (f: File) => (names.push(f.name), `assets/${f.name}`);
    await insertImages(view, [png("a.png"), png("b.png")], view.state.doc.content.size - 1, add);
    expect(names).toEqual(["a.png", "b.png"]);
    expect(editor.save()).toBe("Intro.\n\n![](assets/a.png)\n\n![](assets/b.png)\n");
    await editor.destroy();
  });

  test("added inside text go after its paragraph", async () => {
    const editor = await open("First words.\n\nLast.\n");
    await insertImages(editor.view, [png()], 3, async () => "assets/image.png");
    expect(editor.save()).toBe("First words.\n\n![](assets/image.png)\n\nLast.\n");
    await editor.destroy();
  });

  test("added at the end of the page go last", async () => {
    const editor = await open("- a list\n");
    await insertImages(editor.view, [png()], editor.view.state.doc.content.size, async () => "assets/image.png");
    expect(editor.save()).toBe("- a list\n\n![](assets/image.png)\n");
    await editor.destroy();
  });

  test("a file that couldn't be saved is left out", async () => {
    const editor = await open("Words.\n");
    await insertImages(editor.view, [png()], 1, () => Promise.reject(new Error("disk full")));
    expect(editor.save()).toBeNull();
    await editor.destroy();
  });

  test("names with spaces are written as the app escaped them", async () => {
    const editor = await open("Words.\n");
    await insertImages(editor.view, [png()], 1, async () => "assets/My%20photo%20%281%29.png");
    expect(editor.save()).toBe("Words.\n\n![](assets/My%20photo%20%281%29.png)\n");
    await editor.destroy();
  });

  test("pasting an image file saves it and puts it in the page", async () => {
    const added: File[] = [];
    const editor = await open("Words.\n", async (f) => (added.push(f), "assets/image.png"));
    const data = { files: [png()], getData: () => "", types: ["Files"] } as unknown as DataTransfer;
    const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", { value: data });
    editor.view.dom.dispatchEvent(event);
    await new Promise((r) => setTimeout(r));
    expect(added).toHaveLength(1);
    expect(editor.save()).toBe("Words.\n\n![](assets/image.png)\n");
    await editor.destroy();
  });
});
