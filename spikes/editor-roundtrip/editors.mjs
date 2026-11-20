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

// The Tiptap extensions a Notion-like page editor would realistically use.
const tiptapExtensions = () => [
  StarterKit,
  TableKit,
  TaskList,
  TaskItem.configure({ nested: true }),
  Image,
];

const WORD = /\b[a-z]{5,}\b/;

// Tiptap JSON: { type, content: [...], text, marks: [...] }
function editTiptapWord(doc) {
  const visit = (node, inParagraph) => {
    if (node.type === "text" && inParagraph && !node.marks?.some((m) => m.type === "code")) {
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
    editWord: editTiptapWord,
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
    editWord: editTiptapWord,
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

export const editors = [tiptapOfficial(), tiptapCommunity(), blockNote()];
