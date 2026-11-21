// How a code block is drawn: the code, with a language picker and a copy
// button that show when you point at it.
import type { Node } from "@milkdown/kit/prose/model";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";
import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import { $view } from "@milkdown/kit/utils";
import { chooseLanguage } from "./auto.ts";
import { detected } from "./highlight.ts";
import { LANGUAGES, findLanguage } from "./languages.ts";

const COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a2 2 0 0 1 2-2h11"/></svg>';
const CHECK_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

export class CodeBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private pre: HTMLElement;
  private header: HTMLElement;
  private select: HTMLSelectElement;
  private auto: HTMLOptionElement;
  private other: HTMLOptionElement | null = null;
  private copyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private node: Node,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    const doc = view.dom.ownerDocument;
    this.dom = doc.createElement("div");
    this.dom.className = "page-code-block";

    this.header = doc.createElement("div");
    this.header.className = "page-code-header";
    this.header.contentEditable = "false";

    this.select = doc.createElement("select");
    this.select.className = "page-code-language";
    this.select.setAttribute("aria-label", "Code language");
    this.auto = new Option("Auto-detect", "");
    this.select.append(this.auto, ...LANGUAGES.map((l) => new Option(l.label, l.id)));
    this.select.addEventListener("change", () => this.choose(this.select.value));
    // Back to the code after picking, so typing carries on.
    this.select.addEventListener("keydown", (e) => {
      if (e.key === "Escape") view.focus();
    });

    const copy = doc.createElement("button");
    copy.type = "button";
    copy.className = "page-code-copy";
    copy.title = "Copy code";
    copy.setAttribute("aria-label", "Copy code");
    copy.innerHTML = COPY_ICON;
    copy.addEventListener("mousedown", (e) => e.preventDefault()); // keep the cursor where it is
    copy.addEventListener("click", () => {
      void navigator.clipboard?.writeText(this.node.textContent).catch(() => {});
      copy.innerHTML = CHECK_ICON;
      copy.classList.add("done");
      clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => {
        copy.innerHTML = COPY_ICON;
        copy.classList.remove("done");
      }, 1500);
    });

    this.header.append(this.select, copy);
    this.pre = doc.createElement("pre");
    this.contentDOM = doc.createElement("code");
    this.pre.append(this.contentDOM);
    this.dom.append(this.header, this.pre);
    this.render();
  }

  private choose(language: string) {
    const pos = this.getPos();
    if (pos === undefined) return;
    this.view.dispatch(chooseLanguage(this.view.state.tr, pos, language));
    this.view.focus();
  }

  /** Shows the block's language in the picker (and on the element, for styling). */
  private render() {
    const name = this.node.attrs.language as string;
    const known = name ? findLanguage(name) : undefined;
    if (name && !known) {
      // A language we can't highlight, from a file written elsewhere: keep it selectable.
      if (!this.other) {
        this.other = new Option(name, name);
        this.select.append(this.other);
      }
      this.other.text = this.other.value = name;
    } else if (this.other) {
      this.other.remove();
      this.other = null;
    }
    const guess = name ? null : detected(this.node.textContent);
    this.auto.text = guess ? `${findLanguage(guess)!.label} (auto)` : "Auto-detect";
    this.select.value = known?.id ?? name;
    if (name) this.pre.dataset.language = name;
    else delete this.pre.dataset.language;
  }

  update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  stopEvent(event: Event): boolean {
    return this.header.contains(event.target as HTMLElement);
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: globalThis.Node }): boolean {
    if (mutation.type === "selection") return false;
    return this.header.contains(mutation.target) || (mutation.type === "attributes" && mutation.target === this.pre);
  }

  destroy() {
    clearTimeout(this.copyTimer);
  }
}

export const codeBlockView = $view(codeBlockSchema.node, () => (node, view, getPos) => new CodeBlockView(node, view, getPos));
