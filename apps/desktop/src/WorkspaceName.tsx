import { useState } from "react";
import { type WorkspaceInfo, api, errorText } from "./api.ts";

/** The name to save after editing, or null when nothing should change. */
export function renameTo(draft: string, current: string): string | null {
  const name = draft.trim();
  return name && name !== current ? name : null;
}

/**
 * The workspace name in the sidebar header. Click it to rename: Enter or
 * leaving the field saves, Escape cancels, and an empty name keeps the old
 * one. The name syncs to every device; folders and remotes keep theirs.
 */
export function WorkspaceName({
  workspace,
  onRenamed,
  onError,
}: {
  workspace: WorkspaceInfo;
  onRenamed: (w: WorkspaceInfo) => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const finish = async (save: boolean) => {
    const name = save && draft !== null ? renameTo(draft, workspace.name) : null;
    setDraft(null);
    if (!name) return;
    try {
      onRenamed(await api.renameWorkspace(name));
    } catch (e) {
      onError(errorText(e));
    }
  };

  if (draft === null) {
    return (
      <button
        className="workspace-name"
        title={`Rename “${workspace.name}”`}
        onClick={() => setDraft(workspace.name)}
      >
        {workspace.name}
      </button>
    );
  }
  return (
    <input
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      className="workspace-name editing"
      aria-label="Workspace name"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          void finish(false);
        }
      }}
      spellCheck={false}
    />
  );
}
