// Images and other files in a page's `assets/` folder, as the editor sees
// them: shown through the `page-asset:` protocol (src-tauri/src/page_assets.rs).
import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * The file under the workspace's `pages/` that a link in page `pageId`
 * means (`assets/photo%201.png` → `<pageId>/assets/photo 1.png`), or null
 * for an address to load as it is (https:, data:) or one leading outside.
 */
export function assetPath(pageId: string, src: string): string | null {
  if (!src || /^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith("/") || src.startsWith("#")) return null;
  const parts = [pageId];
  for (const segment of src.split(/[?#]/)[0].split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (!parts.pop()) return null;
      continue;
    }
    try {
      parts.push(decodeURIComponent(segment));
    } catch {
      parts.push(segment);
    }
  }
  return parts.length ? parts.join("/") : null;
}

/** The address the editor loads an image in page `pageId` from. */
export function imageUrl(pageId: string, src: string): string {
  const path = assetPath(pageId, src);
  return path === null ? src : convertFileSrc(path, "page-asset");
}
