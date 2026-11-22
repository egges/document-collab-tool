// Telling remotes apart on the frontend, as `cloud.rs` does on the Rust side.

/** Whether a remote is a `.docsync` folder on this device (as in `cloud::is_folder_remote`). */
export function isFolderRemote(url: string | null): boolean {
  if (!url) return false;
  const path = trimmed(url);
  const absolute = path.startsWith("/") || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith("\\\\");
  return absolute && path.endsWith(".docsync");
}

/** "Notes.docsync" for a folder remote's path. */
export function folderName(url: string): string {
  return trimmed(url).split(/[/\\]/).pop() ?? url;
}

/** The folder a folder remote is in: `/Dropbox/Work` for `/Dropbox/Work/Notes.docsync`. */
export function folderOfRemote(url: string): string {
  const path = trimmed(url);
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

function trimmed(url: string): string {
  return url
    .trim()
    .replace(/^file:\/\//, "")
    .replace(/[/\\]+$/, "");
}
