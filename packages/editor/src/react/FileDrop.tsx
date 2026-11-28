import { useEffect, useState } from "react";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { DropTarget } from "../blocks.ts";
import { imageFiles, insertImages } from "../images.ts";
import { DropLine } from "./DropLine.tsx";
import { GUTTER, dropTargetAt } from "./geometry.ts";

/**
 * Image files dragged from outside onto the page: the line shows where they
 * will go, between blocks and at a nesting level, as when moving a block. Anywhere in the text's
 * column counts, from its top down to the bottom of the page, so dropping
 * below the last block puts them last.
 */
export function FileDrop({ view, container, addImage }: {
  view: EditorView;
  container: React.RefObject<HTMLDivElement | null>;
  addImage: (file: File) => Promise<string>;
}) {
  const [target, setTarget] = useState<DropTarget | null>(null);

  useEffect(() => {
    const hasFiles = (event: DragEvent) => !!event.dataTransfer?.types.includes("Files");
    const over = (event: DragEvent) => {
      const box = view.dom.getBoundingClientRect();
      const inside = event.clientY >= box.top - 8 && event.clientX >= box.left - GUTTER && event.clientX <= box.right + 24;
      return inside ? dropTargetAt(view, event.clientX, event.clientY) : null;
    };
    // On the window, capturing: before the editor, which would otherwise
    // take the drop as text, and before the app's refusal of file drops.
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      const found = over(event);
      setTarget((now) => (now?.pos === found?.pos && now?.side === found?.side ? now : found));
      if (!found) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
    };
    const onDrop = (event: DragEvent) => {
      setTarget(null);
      if (!hasFiles(event)) return;
      const found = over(event);
      if (!found) return;
      event.preventDefault();
      const files = imageFiles(event.dataTransfer);
      if (files.length) void insertImages(view, files, found.pos, addImage);
    };
    // Left the window, or the drag was called off.
    const onLeave = (event: DragEvent) => !event.relatedTarget && setTarget(null);
    const onEnd = () => setTarget(null);
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("drop", onDrop, true);
    window.addEventListener("dragleave", onLeave, true);
    window.addEventListener("dragend", onEnd, true);
    return () => {
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("drop", onDrop, true);
      window.removeEventListener("dragleave", onLeave, true);
      window.removeEventListener("dragend", onEnd, true);
    };
  }, [view, addImage]);

  if (!target || !container.current) return null;
  return <DropLine view={view} container={container.current} target={target} />;
}
