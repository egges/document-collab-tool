import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EditorView } from "@milkdown/kit/prose/view";
import { type Block, type DropTarget, blockAt, blockStartingAt, dropTarget, setDragging } from "../blocks.ts";
import type { PageEditor } from "../editor.ts";
import { BlockMenu } from "./BlockMenu.tsx";
import { GripIcon, PlusIcon } from "./icons.tsx";

/** Width of "+" and the grip together, and the gap to the block. */
const HANDLE_WIDTH = 44;
const HANDLE_HEIGHT = 24;
/** How far left of the text the handle still shows (the gutter it sits in). */
const GUTTER = 72;
/** A list item's handle goes left of its bullet or checkbox. */
const MARKER = 22;
/** Pixels the pointer moves before a press on the grip becomes a drag. */
const DRAG_THRESHOLD = 4;

interface Drag {
  block: Block;
  startX: number;
  startY: number;
  pointerId: number;
  started: boolean;
}

/**
 * The block at height `y`: the top-level block there, or, in a list, the
 * innermost item there. Goes by height only, so the gutter (where the handle
 * is) counts as part of the block, and the space between blocks goes to the
 * nearer one.
 */
function blockAtY(view: EditorView, y: number): Block | null {
  let children = childBlocks(view, view.state.doc, 0);
  let found: Block | null = null;
  while (children.length) {
    const child = nearest(view, children, y);
    if (!child) break;
    found = child;
    const { node, pos } = child;
    if (node.type.name === "bullet_list" || node.type.name === "ordered_list") {
      children = childBlocks(view, node, pos + 1);
      continue;
    }
    // In an item, a nested list the pointer is over.
    children = [];
    if (node.type.name === "list_item") {
      for (const inner of childBlocks(view, node, pos + 1)) {
        const isList = inner.node.type.name === "bullet_list" || inner.node.type.name === "ordered_list";
        const rect = isList ? rectOf(view, inner) : null;
        if (rect && y >= rect.top) children = childBlocks(view, inner.node, inner.pos + 1);
      }
    }
  }
  return found;
}

function childBlocks(view: EditorView, parent: Block["node"], start: number): Block[] {
  const blocks: Block[] = [];
  parent.forEach((node, offset) => blocks.push({ node, pos: start + offset }));
  return blocks;
}

function rectOf(view: EditorView, block: Block): DOMRect | null {
  const element = blockElement(view, block);
  return element ? element.getBoundingClientRect() : null;
}

/** The block among `blocks` (in order, top to bottom) containing `y`, or the nearest one. Binary search. */
function nearest(view: EditorView, blocks: Block[], y: number): Block | null {
  let lo = 0;
  let hi = blocks.length - 1;
  // The last block starting above y.
  let index = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const rect = rectOf(view, blocks[mid]);
    if (rect && rect.top <= y) {
      index = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const rect = rectOf(view, blocks[index]);
  const next = blocks[index + 1] && rectOf(view, blocks[index + 1]);
  if (rect && next && y > rect.bottom && next.top - y < y - rect.bottom) return blocks[index + 1];
  return blocks[index];
}

/** The block under a point (see `blockAtY`); hit-tests where layout can't be measured (tests). */
function blockFromPoint(view: EditorView, x: number, y: number): Block | null {
  const box = view.dom.getBoundingClientRect();
  if (box.height > 0) return blockAtY(view, Math.min(Math.max(y, box.top + 1), box.bottom - 1));
  try {
    const hit = view.posAtCoords({ left: x, top: y });
    return hit && blockAt(view.state.doc, hit.inside >= 0 ? hit.inside : hit.pos);
  } catch {
    return null;
  }
}

function blockElement(view: EditorView, block: Block): HTMLElement | null {
  const dom = view.nodeDOM(block.pos);
  return dom instanceof HTMLElement ? dom : null;
}

/** Vertical middle of the block's first line, in client coordinates. */
function firstLineMiddle(element: HTMLElement): number {
  const text = element.matches("p, h1, h2, h3, h4, h5, h6, pre")
    ? element
    : element.querySelector<HTMLElement>("p, h1, h2, h3, h4, h5, h6, pre, th, td");
  const box = element.getBoundingClientRect();
  if (!text) return box.top + box.height / 2;
  const style = getComputedStyle(text);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6 || HANDLE_HEIGHT;
  return text.getBoundingClientRect().top + (parseFloat(style.paddingTop) || 0) + lineHeight / 2;
}

/** Where the handle goes for `block`, relative to the container. */
function handlePosition(view: EditorView, container: HTMLElement, block: Block) {
  const element = blockElement(view, block);
  if (!element) return null;
  const box = container.getBoundingClientRect();
  const isItem = block.node.type.name === "list_item";
  const left = isItem ? element.getBoundingClientRect().left - MARKER : view.dom.getBoundingClientRect().left;
  return { left: left - HANDLE_WIDTH - box.left, top: firstLineMiddle(element) - HANDLE_HEIGHT / 2 - box.top };
}

/** A copy of a block that follows the pointer while it's dragged, as in Notion. */
interface Ghost {
  element: HTMLElement;
  /** Where the pointer is from the copy's top left. */
  dx: number;
  dy: number;
}

/**
 * Copies the block's element into a faded box that follows the pointer.
 * Inside the editor's container, so the page's styles apply; a list item
 * gets a copy of its list around it, so it keeps its bullet or number.
 */
function createGhost(view: EditorView, container: HTMLElement, block: Block, x: number, y: number): Ghost | null {
  const element = blockElement(view, block);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  let copy = element.cloneNode(true) as HTMLElement;
  copy.classList.remove("page-block-dragging", "ProseMirror-selectednode");
  let left = rect.left;
  const list = element.parentElement;
  if (block.node.type.name === "list_item" && list && /^(UL|OL)$/.test(list.tagName)) {
    const wrapper = list.cloneNode(false) as HTMLElement;
    if (wrapper instanceof HTMLOListElement) {
      wrapper.start = (Number(list.getAttribute("start")) || 1) + [...list.children].indexOf(element);
    }
    wrapper.append(copy);
    copy = wrapper;
    left -= parseFloat(getComputedStyle(list).paddingLeft) || 0;
  }
  const content = document.createElement("div");
  content.className = "ProseMirror";
  content.append(copy);
  const ghost = document.createElement("div");
  ghost.className = "page-block-ghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.width = `${rect.right - left}px`;
  ghost.append(content);
  container.append(ghost);
  const result = { element: ghost, dx: x - left, dy: y - rect.top };
  moveGhost(result, x, y);
  return result;
}

function moveGhost(ghost: Ghost, x: number, y: number) {
  ghost.element.style.transform = `translate(${x - ghost.dx}px, ${y - ghost.dy}px)`;
}

/** The element that scrolls the page, for scrolling while dragging near its edges. */
function scrollParent(element: HTMLElement): HTMLElement {
  for (let el: HTMLElement | null = element.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight) return el;
  }
  return document.scrollingElement as HTMLElement;
}

/**
 * The "+" and grip shown left of the block under the pointer, as in Notion.
 * "+" adds a block below (⌥: above) and opens the block menu; dragging the
 * grip moves the block; clicking it selects the block and opens its menu.
 */
export function BlockHandle({ editor, container }: {
  editor: PageEditor;
  container: React.RefObject<HTMLDivElement | null>;
}) {
  const { view, commands } = editor;
  const [hovered, setHovered] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [dragging, setDraggingState] = useState(false);
  const drag = useRef<Drag | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const ghost = useRef<Ghost | null>(null);
  // Never leave a copy behind (the page closed mid-drag).
  useEffect(() => () => ghost.current?.element.remove(), []);
  const frozen = menuOpen || dragging;
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;

  // Follow the pointer over the page and its gutter.
  useEffect(() => {
    let frame = 0;
    const onMove = (event: MouseEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      if (frozenRef.current || frame || !view.dom.isConnected) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const { x, y } = pointer.current;
        const box = view.dom.getBoundingClientRect();
        const near = y >= box.top - 8 && y <= box.bottom + 8 && x >= box.left - GUTTER && x <= box.right + 24;
        const block = near ? blockFromPoint(view, x, y) : null;
        // Not on a conflict block's bars: they aren't blocks to move or add after.
        const bar = block && blockElement(view, block)?.classList.contains("page-conflict-bar");
        setHovered(block && !bar ? block.pos : null);
      });
    };
    // Typing hides it until the pointer moves again.
    const onKey = () => !frozenRef.current && setHovered(null);
    window.addEventListener("mousemove", onMove);
    view.dom.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("mousemove", onMove);
      view.dom.removeEventListener("keydown", onKey);
    };
  }, [view]);

  const block = hovered === null ? null : blockStartingAt(view.state.doc, hovered);
  // The doc changed under a remembered block (or it's gone): close the menu.
  useEffect(() => {
    if (!block && menuOpen) setMenuOpen(false);
  }, [block === null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll while dragging near the top or bottom of the page.
  useEffect(() => {
    if (!dragging) return;
    const scroller = scrollParent(view.dom);
    let frame = requestAnimationFrame(function step() {
      const { y } = pointer.current;
      const box = scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
      const edge = 48;
      const speed = y < box.top + edge ? -(box.top + edge - y) / 3 : y > box.bottom - edge ? (y - (box.bottom - edge)) / 3 : 0;
      if (speed) {
        scroller.scrollTop += Math.max(-20, Math.min(20, speed));
        updateDrop();
      }
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }); // re-armed each render while dragging; cheap

  // Esc cancels a drag.
  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      endDrag(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const updateDrop = () => {
    const current = drag.current;
    if (!current?.started) return;
    const { x, y } = pointer.current;
    const over = blockFromPoint(view, x, y);
    const element = over && blockElement(view, over);
    if (!over || !element) return setDrop(null);
    const box = element.getBoundingClientRect();
    const side = y < box.top + box.height / 2 ? "before" : "after";
    setDrop(dropTarget(view.state.doc, current.block, over, side));
  };

  const endDrag = (commit: boolean) => {
    const current = drag.current;
    drag.current = null;
    if (!current) return;
    ghost.current?.element.remove();
    ghost.current = null;
    if (current.started) {
      view.dispatch(setDragging(view.state.tr, null));
      setDraggingState(false);
      const target = drop;
      setDrop(null);
      if (commit && target) {
        // Positions may have shifted if the page changed during the drag.
        const now = blockStartingAt(view.state.doc, current.block.pos);
        if (now && now.node.eq(current.block.node)) commands.moveBlockTo(now, target.pos);
      }
      view.focus();
    }
  };

  const onGripDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !block) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { block, startX: event.clientX, startY: event.clientY, pointerId: event.pointerId, started: false };
  };

  const onGripMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    pointer.current = { x: event.clientX, y: event.clientY };
    if (!current.started) {
      if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < DRAG_THRESHOLD) return;
      current.started = true;
      // Copy it before it's faded.
      if (container.current) ghost.current = createGhost(view, container.current, current.block, event.clientX, event.clientY);
      setMenuOpen(false);
      setDraggingState(true);
      view.dispatch(setDragging(view.state.tr, current.block.pos));
    }
    if (ghost.current) moveGhost(ghost.current, event.clientX, event.clientY);
    updateDrop();
  };

  const onGripUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.started) return endDrag(true);
    drag.current = null;
    openMenu();
  };

  const openMenu = () => {
    if (!block) return;
    commands.selectBlock(block);
    setMenuOpen(true);
  };

  const add = (event: React.MouseEvent) => {
    if (!block) return;
    commands.insertBlock(block, { above: event.altKey, text: "/" });
    view.focus();
  };

  if (!block || !container.current) return null;
  const position = handlePosition(view, container.current, block);
  if (!position) return null;

  return (
    <>
      <div
        className={`page-block-handle${frozen ? " active" : ""}`}
        style={{ left: position.left, top: position.top }}
        // Never take focus or the selection from the editor.
        onMouseDown={(e) => e.preventDefault()}
      >
        <button
          type="button"
          className="page-block-add"
          aria-label="Add a block below"
          title={"Click to add a block below\n⌥-click to add one above"}
          onClick={add}
        >
          <PlusIcon size={16} />
        </button>
        <button
          type="button"
          className="page-block-grip"
          aria-label="Block menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={"Drag to move\nClick for options"}
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={() => endDrag(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openMenu();
            }
          }}
        >
          <GripIcon size={16} />
        </button>
      </div>
      {drop && <DropLine view={view} container={container.current} target={drop} />}
      {menuOpen && (
        <BlockMenu
          editor={editor}
          block={block}
          left={position.left}
          top={position.top + HANDLE_HEIGHT + 4}
          onClose={() => {
            setMenuOpen(false);
            view.focus();
          }}
        />
      )}
    </>
  );
}

/** The line showing where a dragged block will land. */
function DropLine({ view, container, target }: { view: EditorView; container: HTMLElement; target: DropTarget }) {
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
  const rect = element.getBoundingClientRect();
  const isItem = target.block.node.type.name === "list_item";
  const left = (isItem ? rect.left - MARKER : rect.left) - box.left;
  const right = view.dom.getBoundingClientRect().right - box.left;
  const top = (target.side === "before" ? rect.top - 4 : rect.bottom + 2) - box.top;
  return <div className="page-block-drop" style={{ left, top, width: Math.max(0, right - left) }} />;
}
