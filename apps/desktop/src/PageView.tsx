import { ask } from "@tauri-apps/plugin-dialog";
import type { PageEditor, Reader } from "@sawmill/editor";
import { PageEditorView } from "@sawmill/editor/react";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { type Conflict, type Page, type PageDisplay, type PageProperties as Properties, api, errorText } from "./api.ts";
import { insideText, pagesInside } from "./pageTree.ts";
import { ConflictPanel } from "./ConflictPanel.tsx";
import { DatabasePageView } from "./DatabasePageView.tsx";
import { log } from "./devlog.ts";
import { PageProperties, type PropertyActions } from "./PageProperties.tsx";
import { PageSaver } from "./pageSaver.ts";

export interface PageViewHandle {
  /** Write unsaved edits (title and body). */
  flush(): Promise<void>;
  /** Ask, then delete the page. */
  remove(): Promise<void>;
}

interface PageViewProps {
  id: string;
  /** Changes whenever files changed on disk. */
  diskVersion: number;
  /** Text to select and scroll to once the page loads (opened from a search). */
  reveal?: string | null;
  onOpenLink: (href: string) => void;
  onRenamed: () => void;
  /** The title as it's typed (or changed on disk), before the page list has it. */
  onTitleChange?: (title: string) => void;
  /** How the page is shown, as App has it (null until the page reports it). */
  display: PageDisplay | null;
  /** The page's display options as read from disk (on load, and when changed elsewhere). */
  onDisplay: (display: PageDisplay) => void;
  onDeleted: () => void;
  onError: (message: string) => void;
  /** Open another page: a database's row, from a database page. */
  onOpenPage: (id: string) => void;
  /** Who is reading: their own versions in a conflict block say "You". */
  reader: Reader;
  ref?: Ref<PageViewHandle>;
}

/** Loads the page, then hands over to the editor once it has the body, or to the database page. */
export function PageView(props: PageViewProps) {
  const [page, setPage] = useState<Page | null>(null);
  const { id, onError, onRenamed } = props;
  useEffect(() => {
    let cancelled = false;
    api
      .readPage(id)
      .then((p) => {
        if (cancelled) return;
        setPage(p);
        // Front matter became the title: the sidebar should show it.
        if (p.metaChanged) onRenamed();
      })
      .catch((e) => onError(errorText(e)));
    return () => {
      cancelled = true;
    };
    // Not on onRenamed: it only rereads the page list, so a new one needn't reload the page.
  }, [id, onError]);
  if (!page) return <div className="page" />;
  if (page.database) return <DatabasePageView {...props} initial={{ ...page, database: page.database }} />;
  return <LoadedPage {...props} initial={page} />;
}

function LoadedPage({ id, initial, diskVersion, reveal, onOpenLink, onRenamed, onTitleChange, display, onDisplay, onDeleted, onError, reader, ref }: PageViewProps & { initial: Page }) {
  const [title, setTitle] = useState(initial.title);
  // The conflict blocks in the file, and how many the editor shows as blocks right now.
  const [conflicts, setConflicts] = useState<Conflict[]>(initial.conflicts);
  const [conflictsInPage, setConflictsInPage] = useState(0);
  // The file holds a conflict the editor can't show as a block (one inside
  // a code block, say): list them all above the page instead.
  const [listConflicts, setListConflicts] = useState(false);
  const [properties, setProperties] = useState<Properties>(initial.properties);
  const [notice, setNotice] = useState<string | null>(null);
  // A save problem the saver is retrying. Shown only if it lasts.
  const [problem, setProblem] = useState<string | null>(null);
  const [showProblem, setShowProblem] = useState(false);
  useEffect(() => {
    if (!problem) return setShowProblem(false);
    const timer = setTimeout(() => setShowProblem(true), 5000);
    return () => clearTimeout(timer);
  }, [problem]);
  const [busy, setBusy] = useState(false);
  const titleSaved = useRef(initial.title);
  const titleInput = useRef<HTMLInputElement>(null);
  const editorRef = useRef<PageEditor | null>(null);

  const [saver] = useState(
    () =>
      new PageSaver({
        base: initial.body,
        write: (base, body) => api.writePage(id, base, body),
        log: (message) => log("debug", "save", `Page ${id}: ${message}`),
        onEvent: (event) => {
          switch (event.kind) {
            case "conflicts": {
              // The page was just written or loaded, so the editor shows what the file holds.
              const editor = editorRef.current;
              setConflicts(event.conflicts);
              setListConflicts(!!editor && event.conflicts.length > editor.conflicts.length);
              break;
            }
            case "gone":
              log("warn", "save", `Page ${id} was deleted on another device while open`);
              setNotice("This page was deleted on another device. Your latest edits weren't saved.");
              break;
            case "saved":
              setProblem(null);
              break;
            case "problem":
              setProblem((now) => now ?? event.message);
              break;
          }
        },
      }),
  );

  const saveTitle = async () => {
    const next = titleInput.current?.value ?? title;
    if (next === titleSaved.current) return;
    titleSaved.current = next;
    try {
      await api.renamePage(id, next);
      onRenamed();
    } catch (e) {
      onError(errorText(e));
    }
  };

  useImperativeHandle(ref, () => ({
    flush: async () => {
      await Promise.all([saver.flush(), saveTitle()]);
    },
    remove,
  }));

  useEffect(() => {
    log("info", "ui", `Opened page ${id} (${initial.body.length} chars, ${initial.conflicts.length} conflicts)`);
    onDisplay(initial.display);
  }, [id, initial]);

  // Save edits when leaving the page.
  useEffect(() => () => void saver.flush(), [saver]);

  // Files changed on disk: reread this page.
  const firstDiskVersion = useRef(diskVersion);
  useEffect(() => {
    if (diskVersion === firstDiskVersion.current) return;
    let cancelled = false;
    api
      .readPage(id)
      .then(async (page) => {
        if (cancelled) return;
        await saver.refresh(page);
        onDisplay(page.display);
        setProperties(page.properties);
        if (document.activeElement !== titleInput.current && page.title !== titleSaved.current) {
          titleSaved.current = page.title;
          setTitle(page.title);
          onTitleChange?.(page.title);
        }
      })
      .catch(() => {}); // deleted: the page list update closes this view
    return () => {
      cancelled = true;
    };
  }, [diskVersion, id, saver]);

  // A new page starts with its title focused.
  useEffect(() => {
    if (!initial.title && !initial.body) titleInput.current?.focus();
  }, [initial]);

  const keep = async (index: number, version: number) => {
    setBusy(true);
    try {
      await saver.flush();
      await saver.loaded(await api.resolveConflict(id, index, version));
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  /** Show a property edit at once, save it, then read the properties back from disk. */
  const editProperties = async <T,>(local: ((p: Properties) => Properties) | null, save: () => Promise<T>) => {
    if (local) setProperties(local);
    try {
      return await save();
    } catch (e) {
      onError(errorText(e));
      return null;
    } finally {
      await api
        .readPage(id)
        .then((page) => setProperties(page.properties))
        .catch(() => {});
    }
  };

  const propertyActions: PropertyActions = {
    add: (name) => editProperties(null, () => api.addProperty(id, name, "text")),
    update: (key, change) =>
      void editProperties(
        (p) => ({ ...p, columns: p.columns.map((c) => (c.id === key ? { ...c, ...change } : c)) }),
        () => api.updateProperty(id, key, change),
      ),
    remove: (key) =>
      void editProperties(
        (p) => ({ ...p, columns: p.columns.filter((c) => c.id !== key) }),
        () => api.deleteProperty(id, key),
      ),
    set: (key, value) =>
      void editProperties(
        (p) => {
          const values = { ...p.values };
          if (value === null) delete values[key];
          else values[key] = value;
          return { ...p, values };
        },
        () => api.setProperty(id, key, value),
      ),
    onError,
  };

  const remove = async () => {
    const question = initial.row
      ? `Delete “${title || "Untitled"}” from “${initial.row.name || "Untitled"}”?`
      : `Delete “${title || "Untitled"}”${insideText(pagesInside(await api.listPages(), id).length)}?`;
    const confirmed = await ask(question, {
      title: "Delete page",
      kind: "warning",
      okLabel: "Delete",
    });
    if (!confirmed) return;
    try {
      await api.deletePage(id);
      onDeleted();
    } catch (e) {
      onError(errorText(e));
    }
  };

  return (
    <article
      className="page"
      data-width={(display ?? initial.display).width ?? undefined}
      data-text-size={(display ?? initial.display).textSize ?? undefined}
      onMouseDown={(e) => {
        // A click in the empty space below the last block: write on at the
        // end, as in Notion. Only on the page's background, never on text,
        // buttons or the editor's menus.
        const content = e.currentTarget.querySelector<HTMLElement>(".page-editor .ProseMirror");
        if (e.button !== 0 || !content || !editorRef.current) return;
        if (!isBackground(e.target as Element, e.currentTarget)) return;
        if (e.clientY <= content.getBoundingClientRect().bottom) return;
        e.preventDefault();
        editorRef.current.commands.continueAtEnd();
      }}
    >
      {notice && <div className="banner banner-warn">{notice}</div>}
      <header className="page-header">
        <input
          ref={titleInput}
          className="page-title"
          placeholder="Untitled"
          value={title}
          aria-label="Page title"
          onChange={(e) => {
            setTitle(e.target.value);
            onTitleChange?.(e.target.value);
          }}
          onBlur={() => void saveTitle()}
          onKeyDown={(e) => {
            // Enter or Esc: on to the text.
            if (e.key === "Enter" || e.key === "Escape") {
              e.preventDefault();
              void saveTitle();
              (document.querySelector(".page-editor .ProseMirror") as HTMLElement | null)?.focus();
            }
          }}
        />
        {showProblem && (
          <span className="save-problem" title={problem ?? undefined}>
            Not saved yet
          </span>
        )}
      </header>
      <PageProperties properties={properties} database={initial.row?.name ?? null} actions={propertyActions} />
      <ConflictPanel
        conflicts={conflicts}
        inPage={conflictsInPage}
        listed={listConflicts}
        reader={reader}
        busy={busy}
        onKeep={(i, v) => void keep(i, v)}
        onShow={() => editorRef.current?.showConflict()}
      />
      <PageEditorView
        markdown={initial.body}
        reader={reader}
        onReady={(editor: PageEditor) => {
          editorRef.current = editor;
          setConflictsInPage(editor.conflicts.length);
          setListConflicts(initial.conflicts.length > editor.conflicts.length);
          // After those: a newer version that arrived meanwhile is shown now, and counts instead.
          saver.attach(editor);
          if (reveal && editor.commands.find(reveal)) editor.view.focus();
        }}
        onChange={(editor: PageEditor) => {
          saver.changed();
          setConflictsInPage(editor.conflicts.length);
        }}
        onOpenLink={onOpenLink}
      />
    </article>
  );
}

/** Whether `target` is the page's empty background rather than something in it. */
function isBackground(target: Element, page: Element): boolean {
  return target === page || target.matches(".page-editor, .page-editor > div:not([class*='page-'])");
}
