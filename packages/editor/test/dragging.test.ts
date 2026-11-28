// Property tests for dragging blocks: on random pages, every block is dropped
// at every place offered for it, and each drop must keep the page intact.
// A failure is shrunk by fast-check to a small page and one drop; turn it
// into an example test in blocks.test.ts once fixed.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import fc from "fast-check";
import { NodeSelection } from "@milkdown/kit/prose/state";
import { undo } from "@milkdown/kit/prose/history";
import type { Node } from "@milkdown/kit/prose/model";
import { type Block, type DropTarget, type PageEditor, createPageEditor, dropTargets } from "../src/index.ts";
import { allBlocks, outline, randomPage } from "./randomPages.ts";

// More for a deeper search: RUNS=5000 npx vitest run test/dragging.test.ts
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

const depthOf = (doc: Node, target: DropTarget) => doc.resolve(target.pos).depth;
const describeTarget = (t: DropTarget) => ({ pos: t.pos, parent: t.parent?.pos ?? null });
const contentOf = (doc: Node) => outline(doc).map((line) => line.trim()).sort();

/** Every place each block can be dropped, from every half of every line. */
function everyDrop(doc: Node): { dragged: Block; target: DropTarget }[] {
  const blocks = allBlocks(doc);
  const drops: { dragged: Block; target: DropTarget }[] = [];
  for (const dragged of blocks) {
    const seen = new Set<string>();
    for (const over of blocks) {
      for (const side of ["before", "after"] as const) {
        for (const target of dropTargets(doc, over, side, dragged)) {
          const key = `${target.pos}:${target.parent?.pos}`;
          if (!seen.has(key)) drops.push({ dragged, target });
          seen.add(key);
        }
      }
    }
  }
  return drops;
}

describe("the places offered", () => {
  test("one per nesting level, the top level first, none inside the dragged block", () => {
    fc.assert(
      fc.property(randomPage(), (markdown) => {
        editor.load(markdown);
        const { doc } = editor.view.state;
        const blocks = allBlocks(doc);
        for (const dragged of [undefined, ...blocks]) {
          for (const over of blocks) {
            for (const side of ["before", "after"] as const) {
              const targets = dropTargets(doc, over, side, dragged);
              expect(targets.length).toBeGreaterThan(0);
              const depths = targets.map((t) => depthOf(doc, t));
              depths.forEach((d, i) => i > 0 && expect(d).toBeGreaterThan(depths[i - 1]));
              if (dragged) {
                const inside = targets.filter((t) => t.pos > dragged.pos && t.pos < dragged.pos + dragged.node.nodeSize);
                expect(inside).toEqual([]);
              }
            }
          }
        }
      }),
      { numRuns: RUNS },
    );
  }, TIMEOUT);

  test("the gap between two lines offers the same places from both sides", () => {
    fc.assert(
      fc.property(randomPage(), (markdown) => {
        editor.load(markdown);
        const { doc } = editor.view.state;
        const blocks = allBlocks(doc);
        blocks.slice(1).forEach((below, i) => {
          const above = blocks[i];
          const fromAbove = dropTargets(doc, above, "after").map(describeTarget);
          const fromBelow = dropTargets(doc, below, "before").map(describeTarget);
          expect(fromBelow, `between line ${i + 1} and ${i + 2}`).toEqual(fromAbove);
        });
      }),
      { numRuns: RUNS },
    );
  }, TIMEOUT);
});

describe("dropping a block", () => {
  test("keeps everything on the page, puts the block where offered, saves, and undoes", () => {
    fc.assert(
      fc.property(randomPage(), (markdown) => {
        editor.load(markdown);
        const original = editor.view.state.doc;
        for (const { dragged, target } of everyDrop(original)) {
          const drop = `${dragged.node.toString()} to ${JSON.stringify(describeTarget(target))}`;
          const before = editor.view.state.doc;
          if (!editor.commands.moveBlockTo(dragged, target.pos)) {
            // Only a drop right where the block is does nothing.
            expect([dragged.pos, dragged.pos + dragged.node.nodeSize], drop).toContain(target.pos);
            continue;
          }
          const after = editor.view.state.doc;
          // Swapping a block with an identical one (two rules, say) is the only move that changes nothing.
          const twin = allBlocks(before).some((b) => b.pos !== dragged.pos && b.node.eq(dragged.node));
          if (after.eq(before)) {
            expect(twin, `${drop} changed nothing`).toBe(true);
            undo(editor.view.state, editor.view.dispatch);
            continue;
          }
          after.check();

          // Nothing lost or duplicated.
          expect(contentOf(after), drop).toEqual(contentOf(before));

          // The block moved whole, nested where the place said.
          const { selection } = editor.view.state;
          expect(selection, drop).toBeInstanceOf(NodeSelection);
          expect((selection as NodeSelection).node.eq(dragged.node), drop).toBe(true);
          const $moved = after.resolve(selection.from);
          if (target.parent) {
            expect($moved.parent.type.name, drop).toBe(target.parent.node.type.name);
            expect($moved.index(), drop).toBeGreaterThan(0);
            // The item's or toggle's own line tells which it is: every block's text is unique.
            expect($moved.parent.firstChild!.eq(target.parent.node.firstChild!), drop).toBe(true);
          } else {
            expect($moved.depth, drop).toBe(0);
          }

          // Saving and opening again shows the same page.
          const saved = editor.save();
          expect(saved, drop).not.toBeNull();
          reader.load(saved!);
          expect(outline(reader.view.state.doc), `${drop}, saved as:\n${saved}`).toEqual(outline(after));

          // Undo puts it back.
          undo(editor.view.state, editor.view.dispatch);
          expect(editor.view.state.doc.eq(original), `undoing ${drop}`).toBe(true);
        }
      }),
      { numRuns: RUNS },
    );
  }, TIMEOUT);
});
