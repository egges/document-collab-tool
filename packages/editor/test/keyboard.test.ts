// Property tests for editing with the keyboard: on random pages, random
// sequences of steps (put the cursor somewhere, then press a key, turn the
// block into another kind, or type). After every step the page must be
// valid and save and read back the same; steps that only rearrange keep the
// text in order; and undoing everything gives the original page back.
// A failure is shrunk to a small page and a few steps; once fixed, add it
// as an example test next to the feature's other tests.
import { afterAll, beforeAll, expect, test } from "vitest";
import fc from "fast-check";
import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import { undo } from "@milkdown/kit/prose/history";
import type { Node } from "@milkdown/kit/prose/model";
import { type BlockFormat, type PageEditor, createPageEditor, prepareForSave } from "../src/index.ts";
import { allBlocks, outline, randomPage } from "./randomPages.ts";

// More for a deeper search: RUNS=3000 npx vitest run test/keyboard.test.ts
const RUNS = Number(process.env.RUNS ?? 100);
const TIMEOUT = 5000 + RUNS * 200;

let editor: PageEditor;
let reader: PageEditor; // opens saved pages, to check they read back the same

beforeAll(async () => {
  editor = await createPageEditor({ root: document.createElement("div"), markdown: "" });
  reader = await createPageEditor({ root: document.createElement("div"), markdown: "" });
});

afterAll(async () => {
  await editor.destroy();
  await reader.destroy();
});

// --- Steps ------------------------------------------------------------------

/**
 * What a step must keep of the page's text: all of it in order, the text
 * of each block in any order (moving a block), or nothing (it adds or
 * removes text).
 */
type Keeps = "text" | "blocks" | null;

const KEYS: { key: string; ctrlKey?: boolean; shiftKey?: boolean; keeps: Keeps }[] = [
  { key: "Enter", keeps: "text" },
  { key: "Backspace", keeps: null },
  { key: "Delete", keeps: null },
  { key: "Tab", keeps: "text" },
  { key: "Tab", shiftKey: true, keeps: "text" },
  { key: "Escape", keeps: "text" },
  { key: "ArrowUp", ctrlKey: true, shiftKey: true, keeps: "blocks" },
  { key: "ArrowDown", ctrlKey: true, shiftKey: true, keeps: "blocks" },
  { key: "d", ctrlKey: true, keeps: null },
];

const FORMATS: BlockFormat[] = [
  "text", "heading1", "heading2", "toggle", "toggleHeading1", "toggleHeading2", "bulletList", "numberedList", "taskList", "quote", "codeBlock", "divider", "table",
];

const action = fc.oneof(
  fc.constantFrom(...KEYS).map((key) => ({ press: key })),
  fc.constantFrom(...FORMATS).map((format) => ({ turnInto: format })),
  fc.constant({ type: "z" }),
);

/** Where the cursor goes first: a text block (by index, wrapping around) and where in it, or a whole block. */
const step = fc.record({
  where: fc.nat(30),
  at: fc.constantFrom("start", "middle", "end", "block"),
  action,
});
type Step = typeof step extends fc.Arbitrary<infer T> ? T : never;

function textblocks(doc: Node): number[] {
  const starts: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) starts.push(pos);
    return !node.isTextblock;
  });
  return starts;
}

/** Puts the cursor where `step` says. False when the page has nowhere to put it. */
function placeCursor({ where, at }: Step): boolean {
  const { view } = editor;
  const { doc } = view.state;
  if (at === "block") {
    const blocks = allBlocks(doc);
    if (blocks.length === 0) return false;
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(doc, blocks[where % blocks.length].pos)));
    return true;
  }
  const starts = textblocks(doc);
  if (starts.length === 0) return false;
  const pos = starts[where % starts.length];
  const size = doc.nodeAt(pos)!.content.size;
  const offset = at === "start" ? 0 : at === "end" ? size : Math.floor(size / 2);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, pos + 1 + offset)));
  return true;
}

/** Does the step's action. Returns what it must keep of the page's text. */
function run({ action: a }: Step): Keeps {
  const { view } = editor;
  if ("press" in a) {
    const { key, keeps, ...mods } = a.press;
    const event = new KeyboardEvent("keydown", { key, ...mods });
    view.someProp("handleKeyDown", (f) => f(view, event));
    return keeps;
  }
  if ("turnInto" in a) {
    const block = editor.commands.blockAt(view.state.selection.from);
    if (block) editor.commands.turnBlockInto(block, a.turnInto);
    return "text";
  }
  view.dispatch(view.state.tr.insertText(a.type));
  return null;
}

/** The text of each text block, in any order. */
const blockTexts = (doc: Node) => textblocks(doc).map((pos) => doc.nodeAt(pos)!.textContent).sort();

const describeStep = ({ where, at, action: a }: Step) =>
  `${"press" in a ? JSON.stringify(a.press) : "turnInto" in a ? `turn into ${a.turnInto}` : `type "${a.type}"`} at ${at} of #${where}`;

// --- The test ---------------------------------------------------------------

test("random keyboard edits keep the page valid, savable and undoable", () => {
  fc.assert(
    fc.property(randomPage(), fc.array(step, { minLength: 1, maxLength: 15 }), (markdown, steps) => {
      editor.load(markdown);
      const original = editor.view.state.doc;
      const done: string[] = [];
      for (const s of steps) {
        if (!placeCursor(s)) continue;
        const before = editor.view.state.doc;
        const keeps = run(s);
        const after = editor.view.state.doc;
        done.push(describeStep(s));
        const what = `after ${done.join(", then ")}`;

        after.check();
        // Whitespace aside: Enter in code adds a line break.
        const text = (doc: Node) => doc.textContent.replace(/\s+/g, "");
        if (keeps === "text") expect(text(after), `${what}: text changed`).toBe(text(before));
        if (keeps === "blocks") expect(blockTexts(after), `${what}: text changed`).toEqual(blockTexts(before));

        // Saving and opening again shows the same page.
        let saved: string | null;
        try {
          saved = editor.save();
        } catch (error) {
          throw new Error(`${what}: ${error}\npage: ${after.toString()}`);
        }
        if (saved !== null) {
          reader.load(saved);
          expect(outline(prepareForSave(reader.view.state.doc)), `${what}, saved as:\n${saved}`).toEqual(outline(prepareForSave(after)));
        }
      }

      // Undoing everything gives the original page back.
      for (let i = 0; i < 100 && undo(editor.view.state, editor.view.dispatch); i++);
      expect(editor.view.state.doc.toString(), `undoing ${done.join(", ")}`).toBe(original.toString());
    }),
    { numRuns: RUNS },
  );
}, TIMEOUT);
