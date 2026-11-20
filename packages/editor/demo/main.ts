// Try the page editor by hand: edit on the left, and see on the right exactly
// what would be written to page.md.
import { diffLines } from "diff";
import { type PageEditor, SaveRefusedError, createPageEditor } from "../src/index.ts";
import "../src/style.css";

const pages = import.meta.glob("../test/pages/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pageSelect = $<HTMLSelectElement>("page");
const status = $("status");
const file = $("file");
const pasteDialog = $<HTMLDialogElement>("paste-dialog");
const pasteText = $<HTMLTextAreaElement>("paste-text");

let editor: PageEditor;
let onDisk = "";
let view: "diff" | "disk" = "diff";

function escape(text: string) {
  return text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

function refresh() {
  let pending: string | null = null;
  let error: string | null = null;
  try {
    pending = editor.save();
  } catch (e) {
    error = e instanceof SaveRefusedError ? e.message : String(e);
  }

  status.className = "status" + (error ? " error" : editor.dirty ? " dirty" : "");
  status.textContent = error ? "Save would lose content" : editor.dirty ? "Unsaved changes" : "No changes";

  if (view === "disk") {
    file.innerHTML = escape(onDisk);
  } else if (error) {
    file.innerHTML = `<span class="note">${escape(error)}</span>`;
  } else if (pending === null) {
    file.innerHTML = `<span class="note">Unchanged: saving now writes nothing.</span>\n\n` + escape(onDisk);
  } else {
    file.innerHTML = diffLines(onDisk, pending)
      .map((part) => {
        const text = escape(part.value.replace(/\n$/, ""));
        return part.added ? `<span class="add">${text}</span>` : part.removed ? `<span class="del">${text}</span>` : text + "\n";
      })
      .join("");
  }
}

async function open(markdown: string) {
  await editor?.destroy();
  const root = $("editor");
  root.replaceChildren();
  onDisk = markdown;
  editor = await createPageEditor({ root, markdown, onDirtyChange: refresh });
  refresh();
}

// Refresh the right-hand side on every change, not only on dirty changes.
for (const event of ["input", "keyup", "mouseup"]) {
  $("editor").addEventListener(event, () => editor && refresh());
}

for (const path of Object.keys(pages).sort()) {
  pageSelect.add(new Option(path.split("/").pop()!, path));
}
pageSelect.addEventListener("change", () => open(pages[pageSelect.value]));

$("save").addEventListener("click", () => {
  try {
    const markdown = editor.save();
    if (markdown !== null) {
      onDisk = markdown;
      editor.markSaved();
    }
  } catch {
    // Shown by refresh().
  }
  refresh();
});

for (const button of document.querySelectorAll<HTMLButtonElement>(".tabs button")) {
  button.addEventListener("click", () => {
    view = button.dataset.view as typeof view;
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === button));
    refresh();
  });
}

$("paste").addEventListener("click", () => pasteDialog.showModal());
pasteDialog.addEventListener("close", () => {
  if (pasteDialog.returnValue === "open" && pasteText.value) open(pasteText.value);
});

open(pages[pageSelect.value]);
