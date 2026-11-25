// What to tell the user after an import. Nothing when it simply worked: the
// first imported page opens, and that says enough.
import type { ImportResult } from "./api.ts";

export function importNotice(result: ImportResult): string | null {
  if (result.pageCount === 0) {
    return result.skipped.length
      ? `Nothing was imported: ${listed(result.skipped)} ${result.skipped.length === 1 ? "isn't" : "aren't"} Markdown.`
      : "There were no Markdown files to import.";
  }
  if (!result.skipped.length) return null;
  const pages = result.pageCount === 1 ? "1 page" : `${result.pageCount} pages`;
  return `Imported ${pages}. Left out: ${listed(result.skipped)}.`;
}

/** "a.txt", "a.txt and b.pdf", "a.txt, b.pdf and 3 more". */
function listed(names: string[]): string {
  const quoted = names.map((n) => `“${n}”`);
  if (quoted.length === 1) return quoted[0];
  if (quoted.length <= 3) return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
  return `${quoted.slice(0, 2).join(", ")} and ${quoted.length - 2} more`;
}
