// Images in a page: drawn from wherever the app keeps them, and added by
// pasting image files (dropping them: react/FileDrop.tsx). Each lands in its
// own paragraph, as `![](assets/<file>)`; where the file goes is up to the
// app (`addImage`). An image on its own line is moved like a block, by
// dragging it (react/BlockHandle.tsx).
import { Fragment, type Node } from "@milkdown/kit/prose/model";
import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";
import { type Block, blockAt, isContainer } from "./blocks.ts";

export interface ImageOptions {
  /** The address to load an image from, given its `src` as written in the page. Default: as written. */
  imageSrc?: (src: string) => string;
  /**
   * Saves a pasted or dropped image file and returns the `src` to write in
   * the page. Without it, pasting or dropping images does nothing special.
   * A rejected promise skips that file: report the problem in here.
   */
  addImage?: (file: File) => Promise<string>;
}

export function imagesPlugin(options: ImageOptions): Plugin {
  return new Plugin({
    props: {
      nodeViews: {
        image: (node) => new ImageView(node, options.imageSrc ?? ((src) => src)),
      },
      handlePaste(view, event) {
        const files = imageFiles(event.clipboardData);
        if (!files.length || !options.addImage) return false;
        void insertImages(view, files, view.state.selection.from, options.addImage);
        return true;
      },
      handleDOMEvents: {
        // Images on their own line are dragged as blocks instead.
        dragstart: (view, event) => {
          if (!imageBlock(view, event.target)) return false;
          event.preventDefault();
          return true;
        },
      },
    },
  });
}

class ImageView implements NodeView {
  dom: HTMLImageElement;
  constructor(
    private node: Node,
    private resolve: (src: string) => string,
  ) {
    this.dom = document.createElement("img");
    this.dom.draggable = false;
    this.show(node);
  }
  update(node: Node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.show(node);
    return true;
  }
  private show(node: Node) {
    const { src, alt, title } = node.attrs as { src: string; alt: string; title: string };
    const url = this.resolve(src);
    // Setting it again would reload the image.
    if (this.dom.getAttribute("src") !== url) this.dom.setAttribute("src", url);
    this.dom.alt = alt ?? "";
    if (title) this.dom.title = title;
    else this.dom.removeAttribute("title");
  }
}

/**
 * For an image (`target`) that's alone in its paragraph: its position, and
 * the block it moves with when dragged. Null for anything else, such as an
 * image amid text.
 */
export function imageBlock(view: EditorView, target: EventTarget | null): { pos: number; block: Block } | null {
  if (!(target instanceof HTMLImageElement) || !target.hasAttribute("src") || !view.dom.contains(target)) return null;
  let pos: number;
  try {
    pos = view.posAtDOM(target, 0);
  } catch {
    return null;
  }
  const node = view.state.doc.nodeAt(pos);
  const $pos = view.state.doc.resolve(pos);
  if (node?.type.name !== "image" || $pos.parent.childCount !== 1) return null;
  const block = blockAt(view.state.doc, pos);
  return block && { pos, block };
}

export function imageFiles(data: DataTransfer | null): File[] {
  return Array.from(data?.files ?? []).filter((f) => f.type.startsWith("image/"));
}

/**
 * Saves `files` and puts them in the page at `pos`, each in its own
 * paragraph: in place of an empty paragraph there, after the block, or
 * right there when `pos` is between blocks.
 */
export async function insertImages(
  view: EditorView,
  files: File[],
  pos: number,
  addImage: (file: File) => Promise<string>,
): Promise<void> {
  const srcs = (await Promise.all(files.map((f) => addImage(f).catch(() => null)))).filter((s) => s !== null);
  if (!srcs.length || view.isDestroyed) return;
  const { state } = view;
  const { image, paragraph } = state.schema.nodes;
  const images = srcs.map((src) => image.create({ src, alt: "" }));
  const blocks = Fragment.from(images.map((img) => paragraph.create(null, img)));
  // Others may have typed while the files were saved.
  const $pos = state.doc.resolve(Math.min(pos, state.doc.content.size));
  const tr = state.tr;
  const parent = $pos.parent;
  // The block whose text the position is in: the text block itself, or the
  // list item or toggle whose line it is. Not a table, whose cells take images inline.
  const found = parent.isTextblock && $pos.depth > 0 ? blockAt(state.doc, $pos.pos) : null;
  const around = found && (found.pos === $pos.before() || (isContainer(found.node) && found.pos === $pos.before(-1))) ? found : null;
  const put = (from: number, to: number) => {
    tr.replaceWith(from, to, blocks);
    tr.setSelection(TextSelection.near(tr.doc.resolve(from + blocks.size)));
  };
  if (around?.node === parent && parent.type === paragraph && parent.content.size === 0 && canReplace(state.doc, around.pos, around.pos + parent.nodeSize, blocks)) {
    put(around.pos, around.pos + parent.nodeSize);
  } else if (!parent.isTextblock && canReplace(state.doc, $pos.pos, $pos.pos, blocks)) {
    // Between blocks (a drop target, the end of the page).
    put($pos.pos, $pos.pos);
  } else if (around && canReplace(state.doc, around.pos + around.node.nodeSize, around.pos + around.node.nodeSize, blocks)) {
    put(around.pos + around.node.nodeSize, around.pos + around.node.nodeSize);
  } else if (parent.inlineContent && !parent.type.spec.code) {
    // A table cell holds one paragraph: the images go in its text.
    tr.insert($pos.pos, images);
  } else {
    return;
  }
  view.dispatch(tr.scrollIntoView());
}

function canReplace(doc: Node, from: number, to: number, content: Fragment): boolean {
  const $from = doc.resolve(from);
  return $from.parent.canReplace($from.index(), doc.resolve(to).index(), content);
}
