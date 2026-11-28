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
import * as cm from "@milkdown/kit/preset/commonmark";
import { extendListItemSchemaForTask, gfm, wrapInTaskListInputRule } from "@milkdown/kit/preset/gfm";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { EditorState, Plugin } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";
import type { Node } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { keymap } from "@milkdown/kit/prose/keymap";
import { BLOCK_KEYS, blockStatePlugin } from "./blocks.ts";
import { placeholderPlugin } from "./placeholder.ts";
import { lists } from "./lists.ts";
import { openOnly, openToggles, toggles } from "./toggles.ts";
import { type ImageOptions, imagesPlugin } from "./images.ts";
import { SaveRefusedError, findLostContent } from "./check.ts";
import { codeBlocks } from "./code/index.ts";
import { tableWidthsPlugins } from "./tableView.ts";
import { type Commands, createCommands } from "./commands.ts";
import { type ConflictBlock, type Reader, conflictBlocks, conflictsPlugin, refreshConflicts } from "./conflicts.ts";
import { configureHouseStyle, joinPage, prepareForSave, splitFrontMatter } from "./markdown.ts";

export interface PageEditorOptions extends ImageOptions {
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
  /** Who is reading, so their own versions in a conflict block say "You". Change it with `setReader`. */
  reader?: Reader;
  /** The toggles to open (keys from `onTogglesChange`); the others start closed. */
  openToggles?: string[];
  /** Called when toggles open or close, with the keys of the open ones, to pass back as `openToggles` next time. */
  onTogglesChange?: (open: string[]) => void;
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
  /**
   * The conflict blocks in the page: places two devices edited at once,
   * with both versions kept (see conflicts.ts). The editor draws each as a
   * block with buttons to keep a version.
   */
  readonly conflicts: ConflictBlock[];
  /** Scrolls to the first conflict block. False when there is none. */
  showConflict(): boolean;
  /** Who is reading now: after signing in or out, or renaming the device. */
  setReader(reader: Reader): void;
  /** Formatting commands, for toolbars and menus. */
  readonly commands: Commands;
  /** The ProseMirror view, for UI built around the editor. */
  readonly view: EditorView;
  destroy(): Promise<void>;
}

/** Leaves out of a preset the plugins in `excluded` (single plugins, or Milkdown's pairs). */
function without(preset: MilkdownPlugin[], excluded: (MilkdownPlugin | MilkdownPlugin[])[]): MilkdownPlugin[] {
  const set = new Set(excluded.flat());
  return preset.filter((plugin) => !set.has(plugin));
}

// Milkdown's lists are containers around their items; ours aren't (lists.ts).
const commonmark = without(cm.commonmark, [
  cm.bulletListAttr, cm.bulletListSchema, cm.orderedListAttr, cm.orderedListSchema, cm.listItemAttr, cm.listItemSchema,
  cm.wrapInBulletListInputRule, cm.wrapInOrderedListInputRule,
  cm.listItemKeymap, cm.orderedListKeymap, cm.bulletListKeymap,
  cm.wrapInBulletListCommand, cm.wrapInOrderedListCommand,
  cm.sinkListItemCommand, cm.splitListItemCommand, cm.liftListItemCommand, cm.liftFirstListItemCommand,
  cm.syncListOrderPlugin, cm.remarkAddOrderInListPlugin,
]);
const gfmWithoutLists = without(gfm, [extendListItemSchemaForTask, wrapInTaskListInputRule]);

async function createMilkdown(
  root: HTMLElement,
  body: string,
  onUpdate: () => void = () => {},
  handleKeyDown?: (event: KeyboardEvent) => boolean,
  reader: () => Reader = () => NOBODY,
  images: ImageOptions = {},
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
    .use(gfmWithoutLists)
    .use(lists)
    .use(toggles)
    .use(tableWidthsPlugins)
    .use(codeBlocks)
    .use(history)
    // Before the clipboard plugin, so pasted image files are ours.
    .use($prose(() => imagesPlugin(images)))
    .use(clipboard)
    .use(updates)
    // After `updates`, so open menus get keys such as Escape first.
    .use($prose(() => keymap(BLOCK_KEYS)))
    .use($prose(() => blockStatePlugin()))
    .use($prose(() => placeholderPlugin()))
    .use($prose(() => conflictsPlugin(reader)))
    .create();
}

const NOBODY: Reader = { person: null, device: null };

export async function createPageEditor(options: PageEditorOptions): Promise<PageEditor> {
  let { frontMatter, body } = splitFrontMatter(options.markdown);
  let baseline: Node | null = null; // set once the editor exists
  let pending: { doc: Node; markdown: string } | null = null;
  let onDisk = options.markdown; // the file as last loaded or saved
  let dirty = false;
  let reader = options.reader ?? NOBODY;

  let open = options.openToggles ?? [];
  const updateDirty = () => {
    if (!baseline) return;
    options.onUpdate?.(view);
    const nowOpen = openToggles(view.state);
    if (nowOpen.join("\n") !== open.join("\n")) {
      open = nowOpen;
      options.onTogglesChange?.(open);
    }
    const now = !view.state.doc.eq(baseline);
    if (now !== dirty) {
      dirty = now;
      options.onDirtyChange?.(dirty);
    }
  };

  const editor = await createMilkdown(options.root, body, updateDirty, options.handleKeyDown, () => reader, {
    imageSrc: options.imageSrc,
    addImage: options.addImage,
  });
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  const parse = editor.action((ctx) => ctx.get(parserCtx));
  const serialize = editor.action((ctx) => ctx.get(serializerCtx));
  view.dispatch(openOnly(view.state, open));
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
    get conflicts() {
      return conflictBlocks(view.state);
    },
    showConflict() {
      const first = conflictBlocks(view.state)[0];
      if (!first) return false;
      const bar = view.nodeDOM(first.start.from);
      if (bar instanceof HTMLElement) bar.scrollIntoView?.({ block: "center", behavior: "smooth" });
      return true;
    },
    setReader(next) {
      const keys = ["person", "personId", "device", "deviceId"] as const;
      if (keys.every((k) => (next[k] ?? null) === (reader[k] ?? null))) return;
      reader = next;
      refreshConflicts(view);
    },
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
      // The toggles that were open stay open.
      view.dispatch(openOnly(view.state, open));
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
