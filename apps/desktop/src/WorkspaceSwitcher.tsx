import { useCallback, useRef, useState } from "react";
import { Check, ChevronDown, FolderSearch, Pencil, Plus, Trash2, X } from "lucide-react";
import { type WorkspaceEntry, type WorkspaceInfo, api, errorText } from "./api.ts";
import { onMenuKeyDown, pickFolder, useDismiss } from "./menu.ts";
import { DeleteWorkspace } from "./DeleteWorkspace.tsx";
import { WorkspaceAvatar } from "./Graphics.tsx";
import { WorkspaceNameInput } from "./WorkspaceName.tsx";

/**
 * The workspace name in the sidebar header. Clicking it opens a menu of the
 * workspaces this device knows, to switch between them, with Rename and
 * "Add workspace…" and "Delete workspace…". Double-clicking the name
 * renames it straight away.
 * A workspace whose folder has gone shows "Locate…" to find it again.
 */
export function WorkspaceSwitcher({
  workspace,
  onRenamed,
  onSwitch,
  onAdd,
  onError,
}: {
  workspace: WorkspaceInfo;
  onRenamed: (w: WorkspaceInfo) => void;
  /** Saves the open page, then opens what `open` returns. */
  onSwitch: (open: () => Promise<WorkspaceInfo | null>) => Promise<void>;
  onAdd: () => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [entries, setEntries] = useState<WorkspaceEntry[] | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);
  useDismiss(root, open, close);

  const load = async () => {
    try {
      setEntries(await api.listWorkspaces());
    } catch (e) {
      onError(errorText(e));
    }
  };

  const toggle = () => {
    if (!open) void load();
    setOpen(!open);
  };

  const rename = async (name: string | null) => {
    setRenaming(false);
    if (!name) return;
    try {
      onRenamed(await api.renameWorkspace(name));
    } catch (e) {
      onError(errorText(e));
    }
  };

  const choose = (entry: WorkspaceEntry) => {
    if (entry.current) return close();
    setOpen(false);
    if (entry.missing) void locate(entry);
    else void onSwitch(() => api.openWorkspace(entry.path));
  };

  const locate = async (entry: WorkspaceEntry) => {
    setOpen(false);
    const path = await pickFolder(`Where is “${entry.name}” now?`);
    if (path) await onSwitch(() => api.locateWorkspace(entry.path, path));
  };

  const forget = async (entry: WorkspaceEntry) => {
    try {
      await api.forgetWorkspace(entry.path);
      await load();
    } catch (e) {
      onError(errorText(e));
    }
  };

  if (renaming) return <WorkspaceNameInput name={workspace.name} onDone={(name) => void rename(name)} />;

  return (
    <div className="switcher" ref={root}>
      <button
        ref={trigger}
        className="workspace-name"
        aria-haspopup="menu"
        aria-expanded={open}
        title={workspace.name}
        onClick={toggle}
        onDoubleClick={() => {
          setOpen(false);
          setRenaming(true);
        }}
      >
        <WorkspaceAvatar name={workspace.name} />
        <span className="workspace-name-text">{workspace.name}</span>
        <ChevronDown size={13} className="workspace-name-chevron" aria-hidden />
      </button>
      {open && (
        <div className="menu switcher-menu" role="menu" aria-label="Workspaces" onKeyDown={onMenuKeyDown}>
          {entries === null ? null : (
            <>
              {entries.map((entry) => (
                <div key={entry.path} className={"switcher-row" + (entry.missing ? " missing" : "")}>
                  <button
                    role="menuitem"
                    className="menu-item"
                    autoFocus={entry.current}
                    title={entry.missing ? `Not found at ${entry.path}` : entry.path}
                    onClick={() => choose(entry)}
                  >
                    <span className="menu-check" aria-hidden>
                      {entry.current && <Check size={14} />}
                    </span>
                    <WorkspaceAvatar name={entry.name} size={18} />
                    <span className="menu-label">{entry.name}</span>
                    {entry.missing && <span className="menu-note">Not found</span>}
                  </button>
                  {entry.missing && (
                    <>
                      <button
                        role="menuitem"
                        className="icon-button"
                        title={`Locate “${entry.name}”…`}
                        aria-label={`Locate “${entry.name}”`}
                        onClick={() => void locate(entry)}
                      >
                        <FolderSearch size={14} />
                      </button>
                      <button
                        role="menuitem"
                        className="icon-button"
                        title="Remove from this list (doesn't delete anything)"
                        aria-label={`Remove “${entry.name}” from the list`}
                        onClick={() => void forget(entry)}
                      >
                        <X size={14} />
                      </button>
                    </>
                  )}
                </div>
              ))}
              <div className="menu-separator" role="separator" />
              <button
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setOpen(false);
                  setRenaming(true);
                }}
              >
                <span className="menu-check" aria-hidden>
                  <Pencil size={14} />
                </span>
                <span className="menu-label">Rename</span>
              </button>
              <button
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setOpen(false);
                  setDeleting(true);
                }}
              >
                <span className="menu-check" aria-hidden>
                  <Trash2 size={14} />
                </span>
                <span className="menu-label">Delete workspace…</span>
              </button>
              <div className="menu-separator" role="separator" />
              <button
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setOpen(false);
                  onAdd();
                }}
              >
                <span className="menu-check" aria-hidden>
                  <Plus size={14} />
                </span>
                <span className="menu-label">Add workspace…</span>
              </button>
            </>
          )}
        </div>
      )}
      {deleting && <DeleteWorkspace onDelete={onSwitch} onClose={() => setDeleting(false)} />}
    </div>
  );
}
