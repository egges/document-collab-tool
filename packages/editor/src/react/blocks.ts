import type { BlockFormat } from "../commands.ts";

export interface BlockOption {
  format: BlockFormat;
  label: string;
  /** Short symbol shown in menus. */
  icon: string;
  /** Extra words the slash menu matches on. */
  keywords: string;
  /** Markdown shortcut, shown as a hint. */
  shortcut?: string;
  /** Whether "Turn into" in the toolbar offers it (it only offers text-like blocks). */
  turnInto: boolean;
}

export const BLOCKS: BlockOption[] = [
  { format: "text", label: "Text", icon: "T", keywords: "paragraph plain", turnInto: true },
  { format: "heading1", label: "Heading 1", icon: "H1", keywords: "title h1", shortcut: "#", turnInto: true },
  { format: "heading2", label: "Heading 2", icon: "H2", keywords: "subtitle h2", shortcut: "##", turnInto: true },
  { format: "heading3", label: "Heading 3", icon: "H3", keywords: "h3", shortcut: "###", turnInto: true },
  { format: "bulletList", label: "Bulleted list", icon: "•", keywords: "unordered ul", shortcut: "-", turnInto: true },
  { format: "numberedList", label: "Numbered list", icon: "1.", keywords: "ordered ol", shortcut: "1.", turnInto: true },
  { format: "taskList", label: "To-do list", icon: "☐", keywords: "task checkbox todo", turnInto: true },
  { format: "quote", label: "Quote", icon: "❝", keywords: "blockquote citation", shortcut: ">", turnInto: true },
  { format: "codeBlock", label: "Code", icon: "</>", keywords: "code block snippet", shortcut: "```", turnInto: true },
  { format: "divider", label: "Divider", icon: "—", keywords: "rule hr line separator", shortcut: "---", turnInto: false },
  { format: "table", label: "Table", icon: "▦", keywords: "grid", turnInto: false },
];

/** Blocks matching what's typed after "/": any word of the label or keywords starts with the query. */
export function matchBlocks(query: string): BlockOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return BLOCKS;
  return BLOCKS.filter((block) =>
    `${block.label} ${block.keywords}`.toLowerCase().split(/[\s-]+/).some((word) => word.startsWith(q)) ||
    block.label.toLowerCase().startsWith(q),
  );
}
