import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
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

describe("block handle", () => {
  /** Rests the pointer on the block containing `text` (jsdom has no layout, so hit-testing is stubbed). */
  async function hover(editor: PageEditor, text: string) {
    const { view } = editor;
    let pos = -1;
    view.state.doc.descendants((node, p) => {
      if (pos < 0 && node.isText && node.text!.includes(text)) pos = p;
      return pos < 0;
    });
    view.posAtCoords = () => ({ pos, inside: -1 });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 1, clientY: 1 }));
      await new Promise((r) => requestAnimationFrame(r));
    });
    return container.querySelector<HTMLElement>(".page-block-handle")!;
  }

  const pointer = (type: string, target: Element, x = 0, y = 0) =>
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y }));

  async function openMenu(editor: PageEditor, text: string) {
    const handle = await hover(editor, text);
    const grip = handle.querySelector(".page-block-grip")!;
    await act(() => {
      pointer("pointerdown", grip);
      pointer("pointerup", grip);
    });
    return container.querySelector<HTMLElement>(".page-block-menu")!;
  }

  const item = (menu: HTMLElement, label: string) =>
    [...menu.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.querySelector(".page-menu-label")?.textContent === label)!;

  test("shows next to the hovered block", async () => {
    const editor = await mount("First.\n\nSecond.\n");
    expect(container.querySelector(".page-block-handle")).toBeNull();
    expect(await hover(editor, "Second")).not.toBeNull();
  });

  test("clicking the grip selects the block and opens its menu", async () => {
    const editor = await mount("First.\n\nSecond.\n");
    const menu = await openMenu(editor, "Second");
    expect(editor.view.state.selection).toBeInstanceOf(NodeSelection);
    expect([...menu.querySelectorAll(":scope > div > button .page-menu-label")].map((l) => l.textContent)).toEqual([
      "Turn into", "Duplicate", "Copy", "Move up", "Move down", "Delete",
    ]);
    expect(item(menu, "Move down").disabled).toBe(true);
    await act(() => item(menu, "Move up").click());
    expect(editor.save()).toBe("Second.\n\nFirst.\n");
    expect(container.querySelector(".page-block-menu")).toBeNull();
  });

  test("the menu duplicates, deletes and turns a block into another", async () => {
    const editor = await mount("First.\n\nSecond.\n");
    let menu = await openMenu(editor, "First");
    await act(() => item(menu, "Duplicate").click());
    expect(editor.save()).toBe("First.\n\nFirst.\n\nSecond.\n");

    menu = await openMenu(editor, "Second");
    await act(() => item(menu, "Delete").click());
    expect(editor.save()).toBe("First.\n\nFirst.\n");

    menu = await openMenu(editor, "First");
    await act(() => item(menu, "Turn into").dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    const submenu = menu.querySelector<HTMLElement>(".page-block-submenu")!;
    expect(submenu.querySelector("[aria-checked=true]")?.textContent).toContain("Text");
    await act(() => item(submenu, "Heading 2").click());
    expect(editor.save()).toBe("## First.\n\nFirst.\n");
  });

  test("the menu works from the keyboard", async () => {
    const editor = await mount("First.\n\nSecond.\n");
    const menu = await openMenu(editor, "First");
    const key = (k: string) => act(() => menu.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));
    expect(document.activeElement).toBe(menu);
    await key("ArrowDown"); // Duplicate
    await key("ArrowDown"); // Copy
    await key("ArrowDown"); // Move up: disabled, skipped
    expect(menu.querySelector(".active .page-menu-label")?.textContent).toBe("Move down");
    await key("Enter");
    expect(editor.save()).toBe("Second.\n\nFirst.\n");

    const again = await openMenu(editor, "Second");
    await act(() => again.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector(".page-block-menu")).toBeNull();
    expect(editor.view.state.selection).toBeInstanceOf(NodeSelection); // the block stays selected
  });

  test("+ adds a block below and opens the slash menu", async () => {
    const editor = await mount("First.\n\nSecond.\n");
    const handle = await hover(editor, "First");
    await act(() => handle.querySelector<HTMLButtonElement>(".page-block-add")!.click());
    expect(container.querySelector(".page-slash-menu")).not.toBeNull();
    await press(editor, "Enter"); // Text
    await act(() => editor.view.dispatch(editor.view.state.tr.insertText("Middle.")));
    expect(editor.save()).toBe("First.\n\nMiddle.\n\nSecond.\n");
  });

  test("Escape closes the slash menu without selecting the block", async () => {
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
    expect(view.state.selection).toBeInstanceOf(TextSelection);
  });

  test("dragging the grip moves the block", async () => {
    const editor = await mount("A.\n\nB.\n\nC.\n");
    const handle = await hover(editor, "A.");
    const grip = handle.querySelector(".page-block-grip")!;
    await act(() => pointer("pointerdown", grip, 0, 0));
    // Over the last block, in its lower half (jsdom boxes are empty, so any point is "after").
    let posC = -1;
    editor.view.state.doc.descendants((n, p) => {
      if (n.isText && n.text === "C.") posC = p;
    });
    editor.view.posAtCoords = () => ({ pos: posC, inside: -1 });
    await act(() => pointer("pointermove", grip, 0, 40));
    expect(editor.view.dom.querySelector(".page-block-dragging")?.textContent).toBe("A.");
    expect(container.querySelector(".page-block-drop")).not.toBeNull();
    // A copy of the block follows the pointer, outside the editable text.
    const ghost = container.querySelector<HTMLElement>(".page-block-ghost");
    expect(ghost?.textContent).toBe("A.");
    expect(ghost?.querySelector(".page-block-dragging")).toBeNull();
    expect(editor.view.dom.contains(ghost)).toBe(false);
    await act(() => pointer("pointerup", grip, 0, 40));
    expect(editor.save()).toBe("B.\n\nC.\n\nA.\n");
    expect(editor.view.dom.querySelector(".page-block-dragging")).toBeNull();
    expect(container.querySelector(".page-block-ghost")).toBeNull();
  });
});

describe("table handles", () => {
  const TABLE = "| Name | Role |\n| - | - |\n| Ada | Lead |\n| Alan | Staff |\n";
  const hover = (text: string) =>
    act(() => {
      const cell = [...container.querySelectorAll("td, th")].find((c) => c.textContent === text)!;
      cell.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
  const button = (selector: string) => container.querySelector<HTMLButtonElement>(selector);
  const item = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>(".page-table-menu button")].find((b) => b.textContent === label)!;

  test("appear on the cell under the pointer and edit its row and column", async () => {
    const editor = await mount(TABLE);
    expect(button(".page-table-grip")).toBeNull();
    await hover("Lead");
    expect(button(".page-table-grip.row")).not.toBeNull();
    // The block handle steps aside meanwhile.
    expect(container.querySelector(".page-editor")!.classList.contains("page-table-hover")).toBe(true);
    expect(button(".page-table-grip.column")).not.toBeNull();

    await act(() => button(".page-table-grip.row")!.click());
    expect(item("Insert above").disabled).toBe(false);
    await act(() => item("Delete row").click());
    expect(editor.save()).toBe("| Name | Role |\n| - | - |\n| Alan | Staff |\n");
    expect(container.querySelector(".page-table-menu")).toBeNull();

    await hover("Staff");
    await act(() => button(".page-table-grip.column")!.click());
    await act(() => item("Insert left").click());
    expect(editor.save()).toBe("| Name | | Role |\n| - | - | - |\n| Alan | | Staff |\n");
  });

  test("the header row can't move or go, nor can the last row under it", async () => {
    await mount("| Name |\n| - |\n| Ada |\n");
    await hover("Name");
    await act(() => button(".page-table-grip.row")!.click());
    expect(item("Insert above").disabled).toBe(true);
    expect(item("Delete row").disabled).toBe(true);
    expect(item("Delete row").title).toContain("header");
    expect(item("Insert below").disabled).toBe(false);
    await act(() => button(".page-table-grip.row")!.click()); // the grip closes its menu
    expect(container.querySelector(".page-table-menu")).toBeNull();
    await hover("Ada");
    await act(() => button(".page-table-grip.row")!.click());
    expect(item("Delete row").title).toContain("at least one row");
  });

  test("the + bars add a row and a column at the end", async () => {
    const editor = await mount(TABLE);
    await hover("Ada");
    await act(() => button(".page-table-add.row")!.click());
    expect(editor.save()).toBe("| Name | Role |\n| - | - |\n| Ada | Lead |\n| Alan | Staff |\n| | |\n");
    await hover("Ada");
    await act(() => button(".page-table-add.column")!.click());
    expect(editor.save()).toContain("| Name | Role | |");
  });

  /** Gives the table's rows and header cells a layout: rows 20px tall, columns 100px wide. */
  const layOut = () => {
    const rows = [...container.querySelectorAll("tr")];
    rows.forEach((row, i) => {
      Object.defineProperty(row, "getBoundingClientRect", { configurable: true, value: () => new DOMRect(0, i * 20, 200, 20) });
      [...row.cells].forEach((cell, j) =>
        Object.defineProperty(cell, "getBoundingClientRect", { configurable: true, value: () => new DOMRect(j * 100, i * 20, 100, 20) }),
      );
    });
  };
  const gripEvent = (type: string, target: Element, x = 0, y = 0) =>
    act(() => {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y }));
    });

  test("pressing a grip opens its menu", async () => {
    await mount(TABLE);
    await hover("Ada");
    await gripEvent("pointerdown", button(".page-table-grip.row")!);
    await gripEvent("pointerup", button(".page-table-grip.row")!);
    expect(container.querySelector(".page-table-menu")?.getAttribute("aria-label")).toBe("Row");
  });

  test("dragging a row's grip moves the row, with a line where it goes", async () => {
    const editor = await mount(TABLE);
    await hover("Ada");
    layOut();
    const grip = button(".page-table-grip.row")!;
    await gripEvent("pointerdown", grip, 0, 30);
    await gripEvent("pointermove", grip, 0, 55); // below Alan's middle
    expect(container.querySelector(".page-table-drop")).not.toBeNull();
    expect(container.querySelector(".page-table-dragged")).not.toBeNull();
    // A copy of the row follows the pointer, moving only up and down.
    const ghost = container.querySelector<HTMLElement>(".page-table-ghost")!;
    expect(ghost.textContent).toBe("AdaLead");
    expect(ghost.style.transform).toBe("translate(0px, 45px)");
    await gripEvent("pointerup", grip, 0, 55);
    expect(container.querySelector(".page-table-ghost")).toBeNull();
    expect(container.querySelector(".page-table-menu")).toBeNull();
    expect(editor.save()).toBe("| Name | Role |\n| - | - |\n| Alan | Staff |\n| Ada | Lead |\n");
  });

  test("dragging a column's grip moves the column", async () => {
    const editor = await mount(TABLE);
    await hover("Role");
    layOut();
    const grip = button(".page-table-grip.column")!;
    await gripEvent("pointerdown", grip, 150, 0);
    await gripEvent("pointermove", grip, 20, 0);
    expect(container.querySelector(".page-table-ghost")!.textContent).toBe("RoleLeadStaff");
    // Released anywhere, not just over the grip.
    await gripEvent("pointerup", document.body, 20, 0);
    expect(editor.save()).toBe("| Role | Name |\n| - | - |\n| Lead | Ada |\n| Staff | Alan |\n");
  });

  test("dragging a column's right edge widens it, and the table with it", async () => {
    const editor = await mount(TABLE);
    await hover("Ada");
    layOut();
    const edges = [...container.querySelectorAll<HTMLElement>(".page-table-resize")];
    expect(edges).toHaveLength(2); // between the columns, and the right edge
    await gripEvent("pointerdown", edges[1], 200, 10);
    await gripEvent("pointermove", document.body, 260, 10);
    // Drawn as it moves, saved when released.
    const table = container.querySelector("table")!;
    expect(table.style.width).toBe("260px");
    expect(editor.save()).toBeNull();
    await gripEvent("pointerup", document.body, 260, 10);
    expect(editor.save()).toBe(`<!-- table-widths: 100px 160px -->\n\n${TABLE}`);
    // Now it can go back to fitting its content, or go full width.
    await hover("Ada");
    expect(container.querySelectorAll(".page-table-size button")).toHaveLength(2);
    await act(() => button('.page-table-size [aria-label="Fit table to content"]')!.click());
    expect(editor.save()).toBeNull();
  });

  test("Escape puts a column's width back", async () => {
    const editor = await mount(TABLE);
    await hover("Ada");
    layOut();
    const edge = container.querySelector<HTMLElement>(".page-table-resize")!;
    await gripEvent("pointerdown", edge, 100, 10);
    await gripEvent("pointermove", document.body, 60, 10);
    expect(container.querySelector("table")!.style.width).toBe("160px");
    await act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector("table")!.style.width).toBe("");
    await gripEvent("pointerup", document.body, 60, 10);
    expect(editor.save()).toBeNull();
  });

  test("full width keeps its edges at the page's, and an inner edge moves width between columns", async () => {
    const editor = await mount(TABLE);
    await hover("Ada");
    layOut();
    // Two buttons on the table's top right, each highlighted while it's on.
    const fit = () => button('.page-table-size [aria-label="Fit table to content"]')!;
    const full = () => button('.page-table-size [aria-label="Full-width table"]')!;
    const on = (b: HTMLButtonElement) => b.getAttribute("aria-pressed") === "true";
    expect([on(fit()), on(full())]).toEqual([true, false]);

    // Full width, still sharing the width by content.
    await act(() => full().click());
    expect(editor.save()).toBe(`<!-- table-widths: full -->\n\n${TABLE}`);
    expect(container.querySelector("table")!.style.width).toBe("100%");
    expect([on(fit()), on(full())]).toEqual([true, true]);

    // Dragging the edge between the columns sets their widths.
    await hover("Ada");
    layOut();
    const edges = [...container.querySelectorAll<HTMLElement>(".page-table-resize")];
    expect(edges).toHaveLength(1); // only the one between the columns
    await gripEvent("pointerdown", edges[0], 100, 10);
    await gripEvent("pointermove", document.body, 130, 10);
    await gripEvent("pointerup", document.body, 130, 10);
    expect(editor.save()).toBe(`<!-- table-widths: 65% 35% -->\n\n${TABLE}`);
    expect([on(fit()), on(full())]).toEqual([false, true]);

    // Fit to content keeps it full width.
    await act(() => fit().click());
    expect(editor.save()).toBe(`<!-- table-widths: full -->\n\n${TABLE}`);

    // Full width again turns it off.
    await act(() => full().click());
    expect(editor.save()).toBeNull();
    expect([on(fit()), on(full())]).toEqual([true, false]);
  });

  test("a table with dragged widths keeps its proportions when it goes full width", async () => {
    const editor = await mount(`<!-- table-widths: 100px 300px -->\n\n${TABLE}`);
    await hover("Ada");
    layOut(); // as drawn here: 100px each
    expect(button('.page-table-size [aria-label="Fit table to content"]')!.getAttribute("aria-pressed")).toBe("false");
    await act(() => button('.page-table-size [aria-label="Full-width table"]')!.click());
    expect(editor.save()).toBe(`<!-- table-widths: 50% 50% -->\n\n${TABLE}`);
  });

  test("the header row doesn't drag, nothing drops above it, and Escape cancels", async () => {
    const editor = await mount(TABLE);
    await hover("Name");
    layOut();
    let grip = button(".page-table-grip.row")!;
    expect(grip.classList.contains("fixed")).toBe(true);
    await gripEvent("pointerdown", grip, 0, 10);
    await gripEvent("pointermove", grip, 0, 55);
    expect(container.querySelector(".page-table-drop")).toBeNull();
    await gripEvent("pointerup", grip, 0, 55);
    expect(editor.save()).toBeNull();

    await act(() => button(".page-table-grip.row")!.click()); // close the menu that opened
    await hover("Alan");
    layOut();
    grip = button(".page-table-grip.row")!;
    await gripEvent("pointerdown", grip, 0, 50);
    await gripEvent("pointermove", grip, 0, 2); // above the header: lands under it
    expect(container.querySelector(".page-table-drop")).not.toBeNull();
    await act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(container.querySelector(".page-table-drop")).toBeNull();
    await gripEvent("pointerup", grip, 0, 2);
    expect(editor.save()).toBeNull();
  });

  /** Gives the table's rows and header cells a layout: rows 20px tall, columns 100px wide. */
  test("the menu works from the keyboard", async () => {
    const editor = await mount(TABLE);
    await hover("Ada");
    await act(() => button(".page-table-grip.row")!.click());
    const menu = container.querySelector<HTMLElement>(".page-table-menu")!;
    const key = (k: string) => act(() => menu.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));
    await key("ArrowDown"); // Insert below
    await key("Enter");
    expect(editor.save()).toBe("| Name | Role |\n| - | - |\n| Ada | Lead |\n| | |\n| Alan | Staff |\n");
  });
});
