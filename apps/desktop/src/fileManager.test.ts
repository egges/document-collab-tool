import { expect, test } from "vitest";
import { showInFolderLabel } from "./fileManager.ts";

test("the folder button is named after the platform's file manager", () => {
  expect(showInFolderLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe(
    "Show in Finder",
  );
  expect(showInFolderLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/120")).toBe(
    "Show in Explorer",
  );
  expect(showInFolderLabel("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15")).toBe("Show in Files");
});
