import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { type DeletionInfo, type WorkspaceInfo, api, errorText } from "./api.ts";

/** What the confirmation says happens to the workspace's copies. */
export function deletionSummary(info: DeletionInfo, deleteRepo: boolean): string {
  if (deleteRepo && info.githubRepo) {
    return `The folder goes to the Trash and ${info.githubRepo} is deleted on GitHub, so every device loses it. GitHub can restore the repository from your settings for 90 days.`;
  }
  if (info.unsynced) {
    return info.remote
      ? "Some changes haven't synced yet. The folder goes to the Trash, and it will be the only place those changes are."
      : "This workspace is only on this device. The folder goes to the Trash, and it will be the only copy.";
  }
  return info.githubRepo
    ? `The folder goes to the Trash. The workspace stays on GitHub (${info.githubRepo}) and on your other devices.`
    : "The folder goes to the Trash. The workspace stays where it syncs, and on your other devices.";
}

/**
 * Confirm deleting the open workspace from this device, with the choice
 * (off by default) to delete its GitHub repository too.
 */
export function DeleteWorkspace({
  onDelete,
  onClose,
}: {
  /** Saves the open page, deletes, then opens what's next (or onboarding). */
  onDelete: (deleted: () => Promise<WorkspaceInfo | null>) => Promise<void>;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<DeletionInfo | null>(null);
  const [deleteRepo, setDeleteRepo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.workspaceDeletionInfo().then(setInfo, (e) => setError(errorText(e)));
  }, []);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDelete(() => api.deleteWorkspace(deleteRepo));
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const close = () => !busy && onClose();

  return createPortal(
    <div className="overlay" onMouseDown={close}>
      <div
        className="dialog confirm"
        role="alertdialog"
        aria-label="Delete workspace"
        tabIndex={-1}
        ref={(el) => el?.focus()}
        onKeyDown={(e) => e.key === "Escape" && close()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>Delete “{info?.name ?? "…"}” from this device?</h2>
        {info ? (
          <>
            <p className={info.unsynced && !deleteRepo ? "warn-text" : undefined}>
              {deletionSummary(info, deleteRepo)}
            </p>
            {info.githubRepo && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={deleteRepo}
                  disabled={busy}
                  onChange={(e) => setDeleteRepo(e.target.checked)}
                />
                <span>
                  Also delete <strong>{info.githubRepo}</strong> on GitHub
                </span>
              </label>
            )}
          </>
        ) : (
          !error && <p className="muted">Checking what's synced…</p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="row end">
          <button className="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button danger" disabled={busy || !info} onClick={() => void confirm()}>
            {busy ? "Deleting…" : deleteRepo ? "Delete everywhere" : "Delete from this device"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
