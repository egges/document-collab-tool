// Adapters for the editors under test. Each one turns Markdown into the
// editor's own document (`open`), and that document back into Markdown
// (`save`), exactly as the editor would when a page is loaded and saved.
// `editWord` changes one word in the first plain paragraph of a document, to
// simulate a user's small edit.
import "./dom.mjs";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown as TiptapMarkdown } from "@tiptap/markdown";
import { Markdown as CommunityMarkdown } from "tiptap-markdown";
import { TableKit } from "@tiptap/extension-table";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import Image from "@tiptap/extension-image";
import { ServerBlockNoteEditor } from "@blocknote/server-util";
import {
  Editor as MilkdownEditor,
  parserCtx,
  remarkStringifyOptionsCtx,
  rootCtx,
  schemaCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm, remarkGFMPlugin } from "@milkdown/kit/preset/gfm";

// The Tiptap extensions a Notion-like page editor would realistically use.
const tiptapExtensions = () => [
  StarterKit,
  TableKit,
  TaskList,
  TaskItem.configure({ nested: true }),
  Image,
];

const WORD = /\b[a-z]{5,}\b/;

// ProseMirror JSON (Tiptap and Milkdown): { type, content: [...], text, marks: [...] }
function editProseMirrorWord(doc) {
  const visit = (node, inParagraph) => {
    if (node.type === "text" && inParagraph && !node.marks?.some((m) => m.type === "code" || m.type === "inlineCode")) {
      const match = node.text.match(WORD);
      if (match) {
        node.text = node.text.replace(match[0], "EDITED");
        return match[0];
      }
    }
    for (const child of node.content ?? []) {
      const word = visit(child, node.type === "paragraph");
      if (word) return word;
    }
    return null;
  };
  return visit(doc, false);
}

// BlockNote: an array of blocks { type, content: [{ type: "text", text, styles }], children }
function editBlockNoteWord(blocks) {
  for (const block of blocks) {
    if (block.type === "paragraph" && Array.isArray(block.content)) {
      for (const item of block.content) {
        if (item.type === "text" && !item.styles?.code) {
          const match = item.text.match(WORD);
          if (match) {
            item.text = item.text.replace(match[0], "EDITED");
            return match[0];
          }
        }
      }
    }
    const word = editBlockNoteWord(block.children ?? []);
    if (word) return word;
  }
  return null;
}

function tiptapOfficial() {
  const editor = new Editor({ extensions: [...tiptapExtensions(), TiptapMarkdown] });
  return {
    name: "Tiptap + @tiptap/markdown",
    id: "tiptap",
    async open(md) {
      editor.commands.setContent(md, { contentType: "markdown" });
      return editor.getJSON();
    },
    async save(doc) {
      editor.commands.setContent(doc);
      return editor.getMarkdown();
    },
    editWord: editProseMirrorWord,
  };
}

function tiptapCommunity() {
  const editor = new Editor({
    extensions: [...tiptapExtensions(), CommunityMarkdown.configure({ html: true })],
  });
  return {
    name: "Tiptap + tiptap-markdown (community)",
    id: "tiptap-community",
    async open(md) {
      // tiptap-markdown makes setContent parse strings as Markdown.
      editor.commands.setContent(md);
      return editor.getJSON();
    },
    async save(doc) {
      editor.commands.setContent(doc);
      return editor.storage.markdown.getMarkdown();
    },
    editWord: editProseMirrorWord,
  };
}

function blockNote() {
  const editor = ServerBlockNoteEditor.create();
  return {
    name: "BlockNote",
    id: "blocknote",
    async open(md) {
      return editor.tryParseMarkdownToBlocks(md);
    },
    async save(blocks) {
      return editor.blocksToMarkdownLossy(blocks);
    },
    editWord: editBlockNoteWord,
  };
}

// `houseStyle` sets remark's output options to the style we'd pick for
// pages: `-` bullets and rules, and tables without column padding, so editing
// one cell changes one line.
async function milkdown({ houseStyle = false } = {}) {
  const editor = await MilkdownEditor.make()
    .config((ctx) => {
      ctx.set(rootCtx, document.createElement("div"));
      if (houseStyle) {
        ctx.update(remarkStringifyOptionsCtx, (options) => ({
          ...options,
          bullet: "-",
          rule: "-",
        }));
        ctx.set(remarkGFMPlugin.options.key, { tablePipeAlign: false });
      }
    })
    .use(commonmark)
    .use(gfm)
    .create();
  const run = (fn) => editor.action(fn);
  return {
    name: houseStyle ? "Milkdown, house style" : "Milkdown (commonmark + gfm)",
    id: houseStyle ? "milkdown-house-style" : "milkdown",
    async open(md) {
      return run((ctx) => ctx.get(parserCtx)(md).toJSON());
    },
    async save(doc) {
      return run((ctx) => ctx.get(serializerCtx)(ctx.get(schemaCtx).nodeFromJSON(doc)));
    },
    editWord: editProseMirrorWord,
  };
}

export const editors = [
  tiptapOfficial(),
  tiptapCommunity(),
  blockNote(),
  await milkdown(),
  await milkdown({ houseStyle: true }),
];
