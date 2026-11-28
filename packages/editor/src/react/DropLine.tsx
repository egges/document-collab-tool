import { useLayoutEffect, useState } from "react";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { DropTarget } from "../blocks.ts";
import { blockElement, levelLeft, lineRect } from "./geometry.ts";

/** The line showing where a dropped block will land: from where text starts at its level. */
export function DropLine({ view, container, target }: { view: EditorView; container: HTMLElement; target: DropTarget }) {
  const element = blockElement(view, target.block);
  const [, remeasure] = useState(0);
  // Measure after layout, so the line follows scrolling.
  useLayoutEffect(() => {
    const onScroll = () => remeasure((n) => n + 1);
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, []);
  if (!element) return null;
  const box = container.getBoundingClientRect();
  // Nested first in an item: right under its line, above what's nested in it already.
  const nests = target.parent?.pos === target.block.pos;
  const rect = nests ? lineRect(view, target.block)! : element.getBoundingClientRect();
  const left = levelLeft(view, target.parent) - box.left;
  const right = view.dom.getBoundingClientRect().right - box.left;
  const top = (target.side === "before" ? rect.top - 4 : rect.bottom + 2) - box.top;
  return <div className="page-block-drop" style={{ left, top, width: Math.max(0, right - left) }} />;
}
