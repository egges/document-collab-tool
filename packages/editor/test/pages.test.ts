// Regression tests on the example pages. These guard the properties sync
// depends on: see docs/roadmap.md and spikes/editor-roundtrip.
import { describe, expect, test } from "vitest";
import { createPageEditor, formatPage } from "../src/index.ts";
import { changedLines, editOneWord, pages, render } from "./helpers.ts";

describe.each(pages)("$name", ({ name, markdown }) => {
  test("first save renders the same as the original", async () => {
    expect(render(await formatPage(markdown))).toBe(render(markdown));
  });

  test("first save matches the reviewed output", async () => {
    // To accept a deliberate change: npx vitest run -u, then review the diff.
    await expect(await formatPage(markdown)).toMatchFileSnapshot(`pages/__formatted__/${name}`);
  });

  test("saving again changes nothing", async () => {
    const once = await formatPage(markdown);
    expect(await formatPage(once)).toBe(once);
  });

  test("opening a page doesn't change it", async () => {
    const editor = await createPageEditor({ root: document.createElement("div"), markdown });
    expect(editor.dirty).toBe(false);
    expect(editor.save()).toBeNull();
    await editor.destroy();
  });

  test("a one-word edit changes one line", async () => {
    const once = await formatPage(markdown);
    const editor = await createPageEditor({ root: document.createElement("div"), markdown: once });
    if (!editOneWord(editor.view)) return; // page has no plain paragraph
    const saved = editor.save();
    expect(saved).toContain("EDITED");
    expect(changedLines(once, saved!)).toBe(2); // one line removed, one added
    await editor.destroy();
  });
});
