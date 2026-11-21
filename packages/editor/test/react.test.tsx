import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { PageEditor } from "../src/index.ts";
import { PageEditorView } from "../src/react/index.ts";

// Tell React this is a test environment, so act() works.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
afterEach(() => container?.remove());

async function mount(markdown: string, onOpenLink?: (href: string) => void): Promise<PageEditor> {
  container = document.createElement("div");
  document.body.append(container);
  let ready!: (editor: PageEditor) => void;
  const editor = new Promise<PageEditor>((resolve) => (ready = resolve));
  await act(async () => {
    createRoot(container).render(
      <StrictMode>
        <PageEditorView markdown={markdown} onReady={ready} onOpenLink={onOpenLink} />
      </StrictMode>,
    );
  });
  const ed = await editor;
  await act(async () => {}); // let the double-mounted editor finish tearing down
  return ed;
}

const press = (editor: PageEditor, key: string) =>
  act(() => {
    editor.view.someProp("handleKeyDown", (f) => f(editor.view, new KeyboardEvent("keydown", { key })));
  });

test("mounts exactly one editor under StrictMode", async () => {
  await mount("# Title\n\nBody text.\n");
  expect(container.querySelectorAll(".ProseMirror")).toHaveLength(1);
  expect(container.querySelector("h1")?.textContent).toBe("Title");
});

test("the toolbar appears on a selection and formats it", async () => {
  const editor = await mount("Some words here.\n");
  const { view } = editor;
  await act(() => {
    view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6, 11)));
  });
  const bold = container.querySelector<HTMLButtonElement>('.page-toolbar button[aria-label="Bold"]');
  expect(bold).not.toBeNull();
  await act(() => bold!.click());
  expect(editor.save()).toBe("Some **words** here.\n");
  expect(bold!.getAttribute("aria-pressed")).toBe("true");
});

test("the slash menu filters, navigates and inserts", async () => {
  const editor = await mount("Intro.\n\nx\n");
  const { view } = editor;
  const end = view.state.doc.content.size - 1;
  await act(() => {
    view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
    view.dispatch(view.state.tr.insertText("/head", end - 1, end));
  });
  const options = () => [...container.querySelectorAll(".page-slash-menu [role=option]")].map((o) => o.textContent);
  expect(options()).toEqual(["H1Heading 1#", "H2Heading 2##", "H3Heading 3###"]);

  await press(editor, "ArrowDown");
  expect(container.querySelector(".page-slash-menu .active")?.textContent).toContain("Heading 2");
  await press(editor, "Enter");
  expect(container.querySelector(".page-slash-menu")).toBeNull();
  await act(() => view.dispatch(view.state.tr.insertText("New section")));
  expect(editor.save()).toBe("Intro.\n\n## New section\n");
});

test("Escape closes the slash menu", async () => {
  const editor = await mount("Intro.\n\nx\n");
  const { view } = editor;
  const end = view.state.doc.content.size - 1;
  await act(() => {
    view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
    view.dispatch(view.state.tr.insertText("/", end - 1, end));
  });
  expect(container.querySelector(".page-slash-menu")).not.toBeNull();
  await press(editor, "Escape");
  expect(container.querySelector(".page-slash-menu")).toBeNull();
});

test("clicking a link opens it; with a selection it doesn't", async () => {
  const opened: string[] = [];
  const editor = await mount("See [the docs](https://example.com/docs) here.\n", (href) => opened.push(href));
  const link = container.querySelector<HTMLAnchorElement>(".ProseMirror a")!;
  window.getSelection()!.collapse(link.firstChild, 2);
  await act(() => link.click());
  expect(opened).toEqual(["https://example.com/docs"]);

  // Dragging across the link selects it, to edit it.
  window.getSelection()!.setBaseAndExtent(link.firstChild!, 0, link.firstChild!, 3);
  await act(() => link.click());
  expect(opened).toHaveLength(1);
  expect(editor.save()).toBeNull();
});

test("resting on a link shows a box to copy or edit it; editing can change the text or remove the link", async () => {
  const opened: string[] = [];
  const editor = await mount("See [docs](https://x.org) here.\n", (href) => opened.push(href));
  const hover = async () => {
    const link = container.querySelector<HTMLAnchorElement>(".ProseMirror a")!;
    await act(async () => {
      link.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
    });
    return container.querySelector<HTMLElement>(".page-link-popover")!;
  };
  const button = (box: HTMLElement, label: string) =>
    [...box.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent === label)!;
  const type = (input: HTMLInputElement, value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

  let box = await hover();
  expect(box.querySelector(".page-link-address")?.textContent).toBe("https://x.org");
  expect([...box.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Copy link", "Edit link"]);
  await act(() => box.querySelector<HTMLAnchorElement>(".page-link-address")!.click());
  expect(opened).toEqual(["https://x.org"]);

  box = await hover();
  await act(() => button(box, "Edit link").click());
  const text = box.querySelector<HTMLInputElement>('input[aria-label="Link text"]')!;
  const href = box.querySelector<HTMLInputElement>('input[aria-label="Link address"]')!;
  expect([text.value, href.value]).toEqual(["docs", "https://x.org"]);
  await type(text, "the docs");
  await type(href, "https://y.org");
  await act(() => href.form!.requestSubmit());
  expect(editor.save()).toBe("See [the docs](https://y.org) here.\n");

  box = await hover();
  await act(() => button(box, "Edit link").click());
  await act(() => button(box, "Remove link").click());
  expect(editor.save()).toBe("See the docs here.\n");
  expect(container.querySelector(".page-link-popover")).toBeNull();
});

test("the link box saves addresses that aren't full URLs", async () => {
  const editor = await mount("See [docs](www.example.com) here.\n");
  const link = container.querySelector<HTMLAnchorElement>(".ProseMirror a")!;
  await act(async () => {
    link.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
  });
  await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Edit link"]')!.click());
  const text = container.querySelector<HTMLInputElement>('input[aria-label="Link text"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(text, "the docs");
    text.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(() => container.querySelector<HTMLButtonElement>(".page-link-save")!.click());
  expect(editor.save()).toBe("See [the docs](www.example.com) here.\n");
});
