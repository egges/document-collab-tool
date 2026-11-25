// Tables with sized columns: how the widths are stored in Markdown, and how
// a table is drawn with them.
//
// GFM tables have no place for widths, so a sized table gets an HTML comment
// on the line above it, which other Markdown tools ignore:
//
//   <!-- table-widths: 160px 240px 120px -->     fixed widths
//   <!-- table-widths: 30% 45% 25% -->           full width
//   <!-- table-widths: full -->                  full width, shared by content
//
// A table that follows its content (the default) has no comment. The
// comment is read into the table as it's parsed, so it never shows up in
// the editor, and written back above the table on save.
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import type { Node } from "@milkdown/kit/prose/model";
import type { NodeView } from "@milkdown/kit/prose/view";
import { tableCellSchema, tableHeaderSchema, tableSchema } from "@milkdown/kit/preset/gfm";
import { type $NodeSchema, $remark, $view } from "@milkdown/kit/utils";
import { type TableWidths, fitsContent, tableWidths } from "./tables.ts";

const COMMENT = /^<!--\s*table-widths:\s*([^]*?)\s*-->$/;
const WIDTH = /^(\d+(?:\.\d+)?)(px|%)$/;

/** The comment that goes above `table`, or null when it follows its content. */
export function widthsComment(table: Node): string | null {
  const { layout, widths } = tableWidths(table);
  if (layout === "auto") return null;
  if (fitsContent({ layout, widths })) return "<!-- table-widths: full -->";
  const values = widths as number[];
  if (layout === "fixed") return `<!-- table-widths: ${values.map((w) => `${Math.round(w)}px`).join(" ")} -->`;
  const total = values.reduce((a, b) => a + b, 0);
  return `<!-- table-widths: ${values.map((w) => `${Math.round((w / total) * 1000) / 10}%`).join(" ")} -->`;
}

/** Reads a widths comment: full when every width is a percentage. Null if `html` isn't one. */
export function parseWidthsComment(html: string): { full: boolean; widths: number[] } | null {
  const match = html.trim().match(COMMENT);
  if (!match) return null;
  if (match[1] === "full") return { full: true, widths: [] };
  const parts = match[1].split(/\s+/).map((part) => part.match(WIDTH));
  if (!parts.length || parts.some((p) => !p || !(Number(p[1]) > 0))) return null;
  const units = new Set(parts.map((p) => p![2]));
  if (units.size !== 1) return null;
  return { full: units.has("%"), widths: parts.map((p) => Number(p![1])) };
}

/** An mdast node, loosely. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  [key: string]: unknown;
}

/**
 * The HTML of a block that's nothing but HTML. Milkdown's own remark plugin
 * has already wrapped each block of HTML in a paragraph by then.
 */
function htmlOf(node: MdNode): string | null {
  if (node.type === "html") return node.value ?? null;
  const only = node.type === "paragraph" && node.children?.length === 1 ? node.children[0] : null;
  return only?.type === "html" ? (only.value ?? null) : null;
}

/**
 * Moves each widths comment into the table below it, when Markdown is
 * parsed: `full` on the table and `colwidth` on its cells, which the
 * runners below turn into node attributes. A comment not directly above a
 * table stays as it is.
 */
function liftWidths(node: MdNode) {
  const children = node.children;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const next = children[i + 1];
    if (next?.type === "table") {
      const parsed = parseWidthsComment(htmlOf(child) ?? "");
      if (parsed) {
        next.full = parsed.full;
        for (const row of next.children ?? []) {
          row.children?.forEach((cell, col) => {
            cell.colwidth = parsed.widths[col] ?? null;
          });
        }
        children.splice(i, 1);
        i--;
        continue;
      }
    }
    liftWidths(child);
  }
}

const remarkTableWidths = $remark("tableWidths", () => () => (tree) => liftWidths(tree as unknown as MdNode));

/** The table node, with a `full` attribute and its widths comment. */
const tableWithWidths = tableSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: { ...base.attrs, full: { default: false } },
    parseDOM: [{ tag: "table", getAttrs: (dom) => ({ full: (dom as HTMLElement).dataset.full === "true" }) }],
    toDOM: (node) => ["table", node.attrs.full ? { "data-full": "true" } : {}, ["tbody", 0]],
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        const align = node.align as (string | null)[];
        const children = (node.children as MdNode[]).map((row, i) => ({ ...row, align, isHeader: i === 0 }));
        state.openNode(type, { full: node.full === true });
        state.next(children as never);
        state.closeNode();
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        const comment = widthsComment(node);
        if (comment) state.addNode("html", undefined, comment);
        base.toMarkdown.runner(state, node);
      },
    },
  };
});

/** A cell takes its column's width from the comment. */
const withWidth = <T extends string>(schema: $NodeSchema<T>) =>
  schema.extendSchema((prev) => (ctx) => {
    const base = prev(ctx);
    return {
      ...base,
      parseMarkdown: {
        match: base.parseMarkdown.match,
        runner: (state, node, type) => {
          const width = node.colwidth;
          state.openNode(type, { alignment: node.align as string, colwidth: typeof width === "number" ? [width] : null });
          state.openNode(state.schema.nodes.paragraph!);
          state.next(node.children as never);
          state.closeNode();
          state.closeNode();
        },
      },
    };
  });

/**
 * Sizes `table`'s columns through its `<colgroup>`. Also used while a
 * column edge is dragged, before the widths are in the document.
 */
export function applyWidths(table: HTMLTableElement, { layout, widths }: TableWidths) {
  let colgroup = table.querySelector(":scope > colgroup");
  if (fitsContent({ layout, widths })) {
    // The browser sizes the columns by content (across the page when full).
    colgroup?.remove();
    table.style.width = layout === "full" ? "100%" : "";
    table.style.tableLayout = "";
    table.removeAttribute("data-layout");
    return;
  }
  if (!colgroup) {
    colgroup = document.createElement("colgroup");
    table.prepend(colgroup);
  }
  while (colgroup.children.length > widths.length) colgroup.lastElementChild!.remove();
  while (colgroup.children.length < widths.length) colgroup.append(document.createElement("col"));
  const values = widths as number[];
  const total = values.reduce((a, b) => a + b, 0);
  values.forEach((w, i) => {
    (colgroup.children[i] as HTMLElement).style.width = layout === "full" ? `${(w / total) * 100}%` : `${w}px`;
  });
  table.style.width = layout === "full" ? "100%" : `${total}px`;
  table.style.tableLayout = "fixed";
  table.dataset.layout = layout;
}

/**
 * A table in a wrapper, which scrolls sideways if a table with fixed widths
 * is wider than the page (in a narrow window), and sized by `applyWidths`.
 */
class TableView implements NodeView {
  dom: HTMLDivElement;
  contentDOM: HTMLElement;
  private table: HTMLTableElement;

  constructor(private node: Node) {
    this.dom = document.createElement("div");
    this.dom.className = "page-table";
    this.table = this.dom.appendChild(document.createElement("table"));
    this.contentDOM = this.table.appendChild(document.createElement("tbody"));
    this.render();
  }

  update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  private render() {
    applyWidths(this.table, tableWidths(this.node));
    if (this.node.attrs.full) this.table.dataset.full = "true";
    else delete this.table.dataset.full;
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: globalThis.Node }): boolean {
    if (mutation.type === "selection") return false;
    // The wrapper, the table's style and its <colgroup> are ours.
    return !this.contentDOM.contains(mutation.target);
  }
}

const tableView = $view(tableWithWidths.node, () => (node) => new TableView(node));

export const tableWidthsPlugins: MilkdownPlugin[] = [
  remarkTableWidths,
  tableWithWidths,
  withWidth(tableHeaderSchema),
  withWidth(tableCellSchema),
  tableView,
].flat();
