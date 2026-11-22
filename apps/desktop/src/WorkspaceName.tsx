import { useState } from "react";

/** The name to save after editing, or null when nothing should change. */
export function renameTo(draft: string, current: string): string | null {
  const name = draft.trim();
  return name && name !== current ? name : null;
}

/**
 * Editing the workspace name in the sidebar header: Enter or leaving the
 * field saves, Escape cancels, and an empty name keeps the old one. The name
 * syncs to every device; folders and remotes keep theirs.
 */
export function WorkspaceNameInput({
  name,
  onDone,
}: {
  name: string;
  /** The new name, or null when nothing should change. */
  onDone: (name: string | null) => void;
}) {
  const [draft, setDraft] = useState(name);
  // Enter saves, and then the field's blur would save again.
  const [done, setDone] = useState(false);
  const finish = (save: boolean) => {
    if (done) return;
    setDone(true);
    onDone(save ? renameTo(draft, name) : null);
  };
  return (
    <input
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      className="workspace-name editing"
      aria-label="Workspace name"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      }}
      spellCheck={false}
    />
  );
}
