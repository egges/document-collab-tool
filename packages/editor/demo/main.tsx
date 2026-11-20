// Try the page editor by hand: edit on the left, and see on the right exactly
// what would be written to page.md.
import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { diffLines } from "diff";
import { type PageEditor, SaveRefusedError } from "../src/index.ts";
import { PageEditorView } from "../src/react/index.ts";
import "../src/style.css";

const pages = import.meta.glob("../test/pages/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const names = Object.keys(pages).sort();

type Pending = { kind: "unchanged" } | { kind: "changed"; markdown: string } | { kind: "refused"; message: string };

function pendingSave(editor: PageEditor | null): Pending {
  if (!editor) return { kind: "unchanged" };
  try {
    const markdown = editor.save();
    return markdown === null ? { kind: "unchanged" } : { kind: "changed", markdown };
  } catch (e) {
    return { kind: "refused", message: e instanceof SaveRefusedError ? e.message : String(e) };
  }
}

function Diff({ from, to }: { from: string; to: string }) {
  return (
    <>
      {diffLines(from, to).map((part, i) => {
        const text = part.value.replace(/\n$/, "");
        if (part.added) return <span key={i} className="add">{text}</span>;
        if (part.removed) return <span key={i} className="del">{text}</span>;
        return <span key={i}>{text + "\n"}</span>;
      })}
    </>
  );
}

function App() {
  const [name, setName] = useState(names[0]);
  const [onDisk, setOnDisk] = useState(pages[names[0]]);
  // Bumped to open a page in a fresh editor (new key), even if the text is the same.
  const [openCount, setOpenCount] = useState(0);
  const [view, setView] = useState<"diff" | "disk">("diff");
  const editor = useRef<PageEditor | null>(null);
  const [, setTick] = useState(0);
  const refresh = () => setTick((n) => n + 1);
  const pasteDialog = useRef<HTMLDialogElement>(null);
  const [pasteText, setPasteText] = useState("");

  const open = (markdown: string) => {
    editor.current = null;
    setOnDisk(markdown);
    setOpenCount((n) => n + 1);
  };

  const pending = pendingSave(editor.current);
  const status =
    pending.kind === "refused" ? ["error", "Save would lose content"]
    : editor.current?.dirty ? ["dirty", "Unsaved changes"]
    : ["", "No changes"];

  const save = () => {
    if (pending.kind === "changed") {
      setOnDisk(pending.markdown);
      editor.current!.markSaved();
    }
    refresh();
  };

  return (
    <>
      <header>
        <strong>Page editor demo</strong>
        <label>
          Page{" "}
          <select
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              open(pages[e.target.value]);
            }}
          >
            {names.map((n) => (
              <option key={n} value={n}>{n.split("/").pop()}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => pasteDialog.current?.showModal()}>Open your own Markdown…</button>
        <span className={`status ${status[0]}`}>{status[1]}</span>
        <button type="button" className="primary" onClick={save}>Save</button>
      </header>

      <dialog
        ref={pasteDialog}
        onClose={() => {
          if (pasteDialog.current?.returnValue === "open" && pasteText) open(pasteText);
        }}
      >
        <form method="dialog">
          <p>Paste Markdown to open it as a page.</p>
          <textarea rows={16} spellCheck={false} value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
          <menu>
            <button value="cancel">Cancel</button> <button value="open" className="primary">Open</button>
          </menu>
        </form>
      </dialog>

      <main>
        <section className="pane">
          <h2>Editor <span className="hint">Select text for the toolbar · type / on an empty line for blocks</span></h2>
          <PageEditorView
            key={openCount}
            markdown={onDisk}
            onReady={(ed) => {
              editor.current = ed;
              refresh();
            }}
            onChange={refresh}
          />
        </section>
        <section className="pane">
          <h2>
            <span>page.md</span>
            <span className="tabs">
              <button type="button" className={view === "diff" ? "active" : ""} onClick={() => setView("diff")}>
                Changes if saved now
              </button>
              <button type="button" className={view === "disk" ? "active" : ""} onClick={() => setView("disk")}>
                On disk
              </button>
            </span>
          </h2>
          <pre id="file">
            {view === "disk" ? onDisk
              : pending.kind === "refused" ? <span className="note">{pending.message}</span>
              : pending.kind === "unchanged" ? <><span className="note">Unchanged: saving now writes nothing.</span>{"\n\n" + onDisk}</>
              : <Diff from={onDisk} to={pending.markdown} />}
          </pre>
        </section>
      </main>
    </>
  );
}

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
