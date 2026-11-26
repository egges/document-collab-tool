import { type RefObject, useEffect, useLayoutEffect, useReducer, useState } from "react";
import type { PageEditor } from "../editor.ts";

interface Frame {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Where each conflict block is, relative to the editor's container: from its first bar to its last. */
function measure(editor: PageEditor, container: HTMLElement | null): Frame[] {
  if (!container) return [];
  const box = container.getBoundingClientRect();
  const page = editor.view.dom.getBoundingClientRect();
  const frames: Frame[] = [];
  for (const block of editor.conflicts) {
    const first = editor.view.nodeDOM(block.start.from);
    const last = editor.view.nodeDOM(block.end.from);
    if (!(first instanceof HTMLElement) || !(last instanceof HTMLElement)) continue;
    const top = first.getBoundingClientRect().top;
    frames.push({
      top: top - box.top,
      left: page.left - box.left,
      width: page.width,
      height: last.getBoundingClientRect().bottom - top,
    });
  }
  return frames;
}

const same = (a: Frame[], b: Frame[]) =>
  a.length === b.length &&
  a.every((f, i) => f.top === b[i].top && f.left === b[i].left && f.width === b[i].width && f.height === b[i].height);

/**
 * The outline around each conflict block. The bars and the versions between
 * them are ordinary blocks of the page, so what makes them one block is
 * this frame drawn over them. It lets clicks through.
 */
export function ConflictFrames({ editor, container }: { editor: PageEditor; container: RefObject<HTMLDivElement | null> }) {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [, remeasure] = useReducer((n: number) => n + 1, 0);

  // After every render: the editor view renders again on each change to the page.
  useLayoutEffect(() => {
    const next = measure(editor, container.current);
    setFrames((now) => (same(now, next) ? now : next));
  });

  // The page can also change size without changing: a narrower window, a
  // bigger text size, an image that finished loading.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(remeasure);
    observer.observe(editor.view.dom);
    return () => observer.disconnect();
  }, [editor]);

  return frames.map((frame, i) => <div key={i} className="page-conflict-frame" style={frame} aria-hidden />);
}
