// Saving the open page: when to write, and what to do when the file changed
// on disk in the meantime. No React and no Tauri here, so it can be tested
// with a fake editor and a fake write.
//
// The rule that keeps edits safe: `base` is always the version the editor's
// content was derived from. Every write sends it along, and the Rust side
// merges when the file no longer matches it (a sync pulled changes in, or an
// AI agent edited the page). So saving never overwrites someone else's edit.

import type { Conflict, Page, WriteResult } from "./api.ts";

/** The parts of the page editor (packages/editor) the saver uses. */
export interface EditorLike {
  save(): string | null;
  markSaved(): void;
  load(markdown: string): void;
}

export type SaverEvent =
  /** The conflict blocks in the page, after every write or reload. */
  | { kind: "conflicts"; conflicts: Conflict[] }
  /** Everything typed so far is written. Clears an earlier problem. */
  | { kind: "saved" }
  /** Another device deleted the page. */
  | { kind: "gone" }
  /**
   * The editor refused to save because the result would lose content, or
   * the write failed. The saver tries again by itself (on the next change,
   * or after `retryDelay`), so this is for a quiet indicator, not an alert.
   */
  | { kind: "problem"; message: string };

export interface PageSaverOptions {
  /** The body as it was read from disk. */
  base: string;
  write: (base: string, body: string) => Promise<WriteResult>;
  onEvent: (event: SaverEvent) => void;
  /** How long after the last change to save. */
  delay?: number;
  /** How long to wait before trying a failed write again. */
  retryDelay?: number;
}

export class PageSaver {
  private base: string;
  private editor: EditorLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** All writes and reloads run one after another. */
  private queue: Promise<void> = Promise.resolve();
  private gone = false;
  private readonly delay: number;
  private readonly retryDelay: number;

  constructor(private readonly options: PageSaverOptions) {
    this.base = options.base;
    this.delay = options.delay ?? 600;
    this.retryDelay = options.retryDelay ?? 3000;
  }

  /** A newer version that arrived before the editor existed. */
  private waiting: Page | null = null;

  attach(editor: EditorLike | null) {
    this.editor = editor;
    if (editor && this.waiting) {
      this.show(editor, this.waiting);
      this.waiting = null;
    }
  }

  /** The user changed the page: save soon. */
  changed(delay = this.delay) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  /** Save now. Resolves once everything changed so far is written. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.enqueue(() => this.save());
  }

  /** The file changed on disk. Show the new version unless the user has unsaved edits, which get merged with it instead. */
  refresh(page: Page): Promise<void> {
    return this.enqueue(async () => {
      if (page.body === this.base) return;
      if (!this.editor) {
        this.waiting = page;
        return;
      }
      const before = this.base;
      await this.save();
      // If that wrote anything, `page` is older than the file now, and the
      // write's result (merged or not) is already what the editor shows.
      const editor = this.editor;
      if (!editor || this.gone || this.base !== before) return;
      if (this.trySave(editor) === null) {
        this.show(editor, page);
      } else {
        // Typed while we were saving: the next save merges with the new file.
        this.changed();
      }
    });
  }

  /** A conflict was resolved on disk; show the result. */
  loaded(page: Page): Promise<void> {
    return this.enqueue(async () => {
      if (this.editor) this.show(this.editor, page);
      else this.waiting = page;
    });
  }

  private show(editor: EditorLike, page: Page) {
    editor.load(page.body);
    this.base = page.body;
    this.options.onEvent({ kind: "conflicts", conflicts: page.conflicts });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task).catch((e: unknown) => {
      this.options.onEvent({ kind: "problem", message: e instanceof Error ? e.message : String(e) });
      this.changed(this.retryDelay);
    });
    this.queue = run;
    return run;
  }

  /** `editor.save()`, reporting a refusal instead of throwing. */
  private trySave(editor: EditorLike): string | null | "refused" {
    try {
      return editor.save();
    } catch (e) {
      if (e instanceof Error && e.name === "SaveRefusedError") {
        // Retried on the next change; the file on disk stays as it was.
        this.options.onEvent({ kind: "problem", message: e.message });
        return "refused";
      }
      throw e;
    }
  }

  private async save(): Promise<void> {
    const editor = this.editor;
    if (!editor || this.gone) return;
    const body = this.trySave(editor);
    if (body === null || body === "refused") return;

    const result = await this.options.write(this.base, body);
    switch (result.status) {
      case "written":
        this.base = body;
        editor.markSaved();
        this.options.onEvent({ kind: "conflicts", conflicts: result.conflicts });
        this.options.onEvent({ kind: "saved" });
        break;
      case "merged":
        editor.markSaved(); // the editor's content is now `body`'s, saved
        this.options.onEvent({ kind: "saved" });
        if (this.trySave(editor) === null) {
          this.show(editor, result.page);
        } else {
          // The user typed during the write. Keep their edits: the editor's
          // content now derives from `body`, so the next save merges it with
          // the merged file on disk, and then shows the result.
          this.base = body;
          this.changed();
        }
        break;
      case "gone":
        this.gone = true;
        this.options.onEvent({ kind: "gone" });
        break;
    }
  }
}
