import { ask } from "@tauri-apps/plugin-dialog";
import type { PageEditor } from "@document-collab-tool/editor";
import { PageEditorView } from "@document-collab-tool/editor/react";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { type Conflict, type Page, api, errorText } from "./api.ts";
import { ConflictPanel } from "./ConflictPanel.tsx";
import { PageSaver } from "./pageSaver.ts";

export interface PageViewHandle {
  /** Write unsaved edits (title and body). */
  flush(): Promise<void>;
}

interface PageViewProps {
  id: string;
  /** Changes whenever files changed on disk. */
  diskVersion: number;
  onRenamed: () => void;
  onDeleted: () => void;
  onError: (message: string) => void;
  ref?: Ref<PageViewHandle>;
}

/** Loads the page, then hands over to the editor once it has the body. */
export function PageView(props: PageViewProps) {
  const [page, setPage] = useState<Page | null>(null);
  const { id, onError } = props;
  useEffect(() => {
    let cancelled = false;
    api
      .readPage(id)
      .then((p) => !cancelled && setPage(p))
      .catch((e) => onError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [id, onError]);
  return page ? <LoadedPage {...props} initial={page} /> : <div className="page" />;
}

function LoadedPage({ id, initial, diskVersion, onRenamed, onDeleted, onError, ref }: PageViewProps & { initial: Page }) {
  const [title, setTitle] = useState(initial.title);
  const [conflicts, setConflicts] = useState<Conflict[]>(initial.conflicts);
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

  const [saver] = useState(
    () =>
      new PageSaver({
        base: initial.body,
        write: (base, body) => api.writePage(id, base, body),
        onEvent: (event) => {
          switch (event.kind) {
            case "conflicts":
              setConflicts(event.conflicts);
              break;
            case "gone":
              setNotice("This page was deleted on another device. Your latest edits weren't saved.");
              break;
            case "saved":
              setProblem(null);
              break;
            case "problem":
              console.warn("save problem, retrying:", event.message);
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
  }));

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
        if (document.activeElement !== titleInput.current && page.title !== titleSaved.current) {
          titleSaved.current = page.title;
          setTitle(page.title);
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

  const remove = async () => {
    const confirmed = await ask(`Delete “${title || "Untitled"}”? Pages inside it move to the top level.`, {
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
    <article className="page">
      {notice && <div className="banner banner-warn">{notice}</div>}
      <header className="page-header">
        <input
          ref={titleInput}
          className="page-title"
          placeholder="Untitled"
          value={title}
          aria-label="Page title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void saveTitle()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
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
        <button className="link danger" onClick={() => void remove()}>
          Delete
        </button>
      </header>
      <ConflictPanel conflicts={conflicts} busy={busy} onKeep={(i, v) => void keep(i, v)} />
      <PageEditorView
        markdown={initial.body}
        onReady={(editor: PageEditor) => saver.attach(editor)}
        onChange={() => saver.changed()}
      />
    </article>
  );
}
