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

async function mount(markdown: string): Promise<PageEditor> {
  container = document.createElement("div");
  document.body.append(container);
  let ready!: (editor: PageEditor) => void;
  const editor = new Promise<PageEditor>((resolve) => (ready = resolve));
  await act(async () => {
    createRoot(container).render(
      <StrictMode>
        <PageEditorView markdown={markdown} onReady={ready} />
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
