import { useCallback, useRef, useState } from "react";
import { FileText, FolderOpen, Import } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { onMenuKeyDown, useDismiss } from "./menu.ts";

/**
 * "Import…" under the page tree: Markdown files, or a whole folder (an
 * Obsidian vault, a Notion export, a docs folder). The native file dialog
 * can't offer files and folders at once on every platform, hence the menu.
 */
export function ImportMenu({ onImport }: { onImport: (sources: string[]) => void }) {
  const [shown, setShown] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setShown(false);
    trigger.current?.focus();
  }, []);
  useDismiss(root, shown, close);

  const pick = async (folder: boolean) => {
    setShown(false);
    const picked = folder
      ? await open({ directory: true, title: "Import a folder of Markdown files" })
      : await open({
          multiple: true,
          title: "Import Markdown files",
          filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
        });
    const sources = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
    if (sources.length) onImport(sources);
  };

  return (
    <div className="import" ref={root}>
      <button ref={trigger} className="tree-new" aria-haspopup="menu" aria-expanded={shown} onClick={() => setShown(!shown)}>
        <Import size={14} aria-hidden />
        <span>Import…</span>
      </button>
      {shown && (
        <div className="menu import-menu" role="menu" aria-label="Import" onKeyDown={onMenuKeyDown}>
          <button className="menu-item" role="menuitem" autoFocus onClick={() => void pick(false)}>
            <span className="menu-check" aria-hidden>
              <FileText size={14} />
            </span>
            <span className="menu-label">Markdown files…</span>
          </button>
          <button className="menu-item" role="menuitem" onClick={() => void pick(true)}>
            <span className="menu-check" aria-hidden>
              <FolderOpen size={14} />
            </span>
            <span className="menu-label">A folder (Obsidian, Notion export)…</span>
          </button>
        </div>
      )}
    </div>
  );
}
