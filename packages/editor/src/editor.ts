import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  parserCtx,
  rootCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { history } from "@milkdown/kit/plugin/history";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { EditorState, Plugin } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";
import type { Node } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { SaveRefusedError, findLostContent } from "./check.ts";
import { codeBlocks } from "./code/index.ts";
import { type Commands, createCommands } from "./commands.ts";
import { configureHouseStyle, joinPage, prepareForSave, splitFrontMatter } from "./markdown.ts";

export interface PageEditorOptions {
  /** Element the editor is mounted in. */
  root: HTMLElement;
  /** Contents of page.md. */
  markdown: string;
  /** Called whenever the page goes from unchanged to changed, or back. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Called after every change to the document or the selection. */
  onUpdate?: (view: EditorView) => void;
  /** Gets key presses first; return true to stop the editor handling one (for menus). */
  handleKeyDown?: (event: KeyboardEvent) => boolean;
}

export interface PageEditor {
  /** True when the page differs from the version last loaded or saved. Undoing back to it counts as unchanged. */
  readonly dirty: boolean;
  /**
   * The Markdown to write to page.md, or null when the page is unchanged.
   * Opening a page never produces a save: a page is only rewritten in our
   * house style once someone actually edits it.
   *
   * Throws `SaveRefusedError` if the Markdown, read back, would show less
   * than the editor does. The caller should then keep the old file.
   *
   * Doesn't change `dirty`: call `markSaved()` once the file is written.
   */
  save(): string | null;
  /** Records that the result of the last `save()` was written. */
  markSaved(): void;
  /** Replaces the page, for example after sync pulled a newer version. Clears undo history. */
  load(markdown: string): void;
  /** Formatting commands, for toolbars and menus. */
  readonly commands: Commands;
  /** The ProseMirror view, for UI built around the editor. */
  readonly view: EditorView;
  destroy(): Promise<void>;
}

async function createMilkdown(
  root: HTMLElement,
  body: string,
  onUpdate: () => void = () => {},
  handleKeyDown?: (event: KeyboardEvent) => boolean,
): Promise<Editor> {
  // Runs synchronously after every change, unlike Milkdown's listener plugin,
  // so `dirty` is always current.
  const updates = $prose(
    () =>
      new Plugin({
        view: () => ({ update: onUpdate }),
        props: { handleKeyDown: handleKeyDown && ((_view, event) => handleKeyDown(event)) },
      }),
  );
  return Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, body);
      configureHouseStyle(ctx);
    })
    .use(commonmark)
    .use(gfm)
    .use(codeBlocks)
    .use(history)
    .use(clipboard)
    .use(updates)
    .create();
}

export async function createPageEditor(options: PageEditorOptions): Promise<PageEditor> {
  let { frontMatter, body } = splitFrontMatter(options.markdown);
  let baseline: Node | null = null; // set once the editor exists
  let pending: { doc: Node; markdown: string } | null = null;
  let onDisk = options.markdown; // the file as last loaded or saved
  let dirty = false;

  const updateDirty = () => {
    if (!baseline) return;
    options.onUpdate?.(view);
    const now = !view.state.doc.eq(baseline);
    if (now !== dirty) {
      dirty = now;
      options.onDirtyChange?.(dirty);
    }
  };

  const editor = await createMilkdown(options.root, body, updateDirty, options.handleKeyDown);
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  const parse = editor.action((ctx) => ctx.get(parserCtx));
  const serialize = editor.action((ctx) => ctx.get(serializerCtx));
  baseline = view.state.doc;
  const commands = createCommands(editor);

  return {
    get dirty() {
      return dirty;
    },
    get view() {
      return view;
    },
    commands,
    save() {
      const doc = view.state.doc;
      if (doc.eq(baseline!)) return null;
      const out = serialize(prepareForSave(doc));
      const lost = findLostContent(doc, parse(out));
      if (lost) throw new SaveRefusedError(lost);
      const markdown = joinPage(frontMatter, out);
      // For example when the only change is an empty line.
      if (markdown === onDisk) return null;
      pending = { doc, markdown };
      return markdown;
    },
    markSaved() {
      if (pending) {
        baseline = pending.doc;
        onDisk = pending.markdown;
      }
      pending = null;
      updateDirty();
    },
    load(markdown) {
      onDisk = markdown;
      ({ frontMatter, body } = splitFrontMatter(markdown));
      const doc = parse(body);
      view.updateState(EditorState.create({ doc, plugins: view.state.plugins }));
      baseline = view.state.doc;
      pending = null;
      updateDirty();
    },
    async destroy() {
      await editor.destroy();
    },
  };
}

/**
 * Rewrites a page in our house style, as the editor would on its first save.
 * For the importer, and for tests. Raw HTML, footnotes and front matter are
 * kept; see the regression tests for exactly what changes.
 */
export async function formatPage(markdown: string): Promise<string> {
  const { frontMatter, body } = splitFrontMatter(markdown);
  const editor = await createMilkdown(document.createElement("div"), "");
  try {
    return editor.action((ctx) => {
      const doc = ctx.get(parserCtx)(body);
      const out = ctx.get(serializerCtx)(prepareForSave(doc));
      const lost = findLostContent(doc, ctx.get(parserCtx)(out));
      if (lost) throw new SaveRefusedError(lost);
      return joinPage(frontMatter, out);
    });
  } finally {
    await editor.destroy();
  }
}
