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

/** Whether a remote is a repository on GitHub over HTTPS, the kind the GitHub sign-in opens. */
export function isGitHubRemote(url: string | null): boolean {
  return !!url && /^https:\/\/github\.com\//i.test(url.trim());
}

/** What to tell someone whose remote refused this device, and what they can do about it. */
export interface AccessAdvice {
  /** For the sync bar. */
  label: string;
  text: string;
  /** "signIn" when signing in with GitHub would help. */
  action: "signIn" | null;
}

/**
 * Advice for a sync the remote refused (`noAccess`): not signed in, an
 * account without access, or a repository that's gone. GitHub says "not
 * found" for a private repository an account can't see, so a missing one
 * and one without access look the same.
 */
export function accessAdvice(remote: string | null, login: string | null): AccessAdvice {
  if (!isGitHubRemote(remote)) {
    return {
      label: "Can't sync",
      text: "The server this workspace syncs with didn't let this device in. Changes are saved on this device.",
      action: null,
    };
  }
  if (!login) {
    return {
      label: "Sign in to sync",
      text: "This workspace is kept on GitHub, and this device isn't signed in. Changes are saved here and sync once you sign in.",
      action: "signIn",
    };
  }
  return {
    label: "Can't sync",
    text: `GitHub didn't let @${login} into this workspace's repository. The account may not have access, Pagemesh may not be allowed into it on GitHub, or the repository may have been deleted or renamed. Changes are saved on this device.`,
    action: "signIn",
  };
}
