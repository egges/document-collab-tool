import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { type PageEditor, createPageEditor } from "../editor.ts";
import { BlockHandle } from "./BlockHandle.tsx";
import { LinkPopover } from "./LinkPopover.tsx";
import { SelectionToolbar } from "./SelectionToolbar.tsx";
import { SlashMenu } from "./SlashMenu.tsx";

export interface PageEditorViewProps {
  /** Contents of page.md. When this changes, the editor loads it (`load()`). */
  markdown: string;
  /** Called once the editor exists, with the editor to save from. */
  onReady?: (editor: PageEditor) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Called after every change to the document or the selection. */
  onChange?: (editor: PageEditor) => void;
  /**
   * Called when a link is clicked, with its address as written. Without it,
   * links open with `window.open`.
   */
  onOpenLink?: (href: string) => void;
  className?: string;
}

/** Handles a key press before the editor does; true means it was handled. */
export type KeyHandler = (event: KeyboardEvent) => boolean;

/**
 * The page editor with its toolbar (on selection), slash menu and block
 * handle (drag to move, click for the block menu). Styles:
 * import "@document-collab-tool/editor/style.css".
 */
export function PageEditorView({ markdown, onReady, onDirtyChange, onChange, onOpenLink, className }: PageEditorViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<PageEditor | null>(null);
  // Re-render the menus on every editor update; they read the editor's state directly.
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  // Latest callbacks, so the editor is created once but always calls the current ones.
  const callbacks = useRef({ onReady, onDirtyChange, onChange, onOpenLink });
  useLayoutEffect(() => {
    callbacks.current = { onReady, onDirtyChange, onChange, onOpenLink };
  });
  // The slash menu takes over arrow keys, Enter and Escape while it's open.
  const keyHandler = useRef<KeyHandler>(() => false);

  useEffect(() => {
    let cancelled = false;
    let created: PageEditor | null = null;
    createPageEditor({
      root: root.current!,
      markdown,
      onDirtyChange: (dirty) => callbacks.current.onDirtyChange?.(dirty),
      onUpdate: () => {
        rerender();
        if (created) callbacks.current.onChange?.(created);
      },
      handleKeyDown: (event) => keyHandler.current(event),
    }).then((ed) => {
      if (cancelled) {
        void ed.destroy();
        return;
      }
      created = ed;
      setEditor(ed);
      callbacks.current.onReady?.(ed);
    });
    return () => {
      cancelled = true;
      void created?.destroy();
      setEditor(null);
    };
    // The editor is created once; later `markdown` changes go through load().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loaded = useRef(markdown);
  useEffect(() => {
    if (editor && markdown !== loaded.current) {
      loaded.current = markdown;
      editor.load(markdown);
    }
  }, [editor, markdown]);

  // Focus changes don't change the editor state, but they show and hide the menus.
  useEffect(() => {
    const el = root.current!;
    el.addEventListener("focusin", rerender);
    el.addEventListener("focusout", rerender);
    return () => {
      el.removeEventListener("focusin", rerender);
      el.removeEventListener("focusout", rerender);
    };
  }, []);

  // Clicking a to-do's checkbox (drawn left of the item) ticks it.
  const onMouseDown = (event: React.MouseEvent) => {
    if (!editor) return;
    const item = (event.target as HTMLElement).closest<HTMLElement>('li[data-item-type="task"]');
    if (item && event.clientX < item.getBoundingClientRect().left) {
      event.preventDefault();
      editor.commands.toggleTask(editor.view.posAtDOM(item, 0));
    }
  };

  // Clicking a link opens it, as in Notion. Resting the pointer on it shows a
  // box to copy, edit or remove it (LinkPopover). Dragging across one still
  // selects it, and Shift-click extends the selection.
  const onClick = (event: React.MouseEvent) => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>(".ProseMirror a[href]");
    if (!link) return;
    // Never follow it in this window: that would replace the app.
    event.preventDefault();
    if (event.button !== 0 || event.shiftKey || event.altKey || !window.getSelection()?.isCollapsed) return;
    openLink(link.getAttribute("href")!);
  };
  const openLink = (href: string) => {
    if (callbacks.current.onOpenLink) callbacks.current.onOpenLink(href);
    else window.open(href, "_blank", "noopener");
  };

  return (
    <div ref={container} className={["page-editor", className].filter(Boolean).join(" ")}>
      <div ref={root} onMouseDown={onMouseDown} onClick={onClick} />
      {editor && <SelectionToolbar editor={editor} container={container} />}
      {editor && <LinkPopover editor={editor} container={container} onOpen={openLink} />}
      {editor && <SlashMenu editor={editor} container={container} keyHandler={keyHandler} />}
      {editor && <BlockHandle editor={editor} container={container} />}
    </div>
  );
}
