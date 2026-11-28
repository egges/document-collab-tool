// Which toggles are open on each page, kept on this device in the window's
// local storage: how this person left the page, not part of it, so it never
// syncs. The keys come from the editor (`onTogglesChange`).

const KEY = (page: string) => `sawmill.toggles.${page}`;

export function readOpenToggles(page: string): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY(page)) ?? "[]");
    return Array.isArray(saved) ? saved.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

export function keepOpenToggles(page: string, open: string[]) {
  try {
    if (open.length) localStorage.setItem(KEY(page), JSON.stringify(open));
    else localStorage.removeItem(KEY(page));
  } catch {
    // Not kept: the toggles start closed next time, nothing worse.
  }
}
