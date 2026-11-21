import { expect, test } from "vitest";
import { report } from "./DevPanel.tsx";

test("a copied report has the app details, then one line per entry", () => {
  const time = new Date(2026, 10, 21, 9, 41, 2, 7).getTime();
  const text = report(
    {
      enabled: true,
      version: "0.1.0",
      debugBuild: true,
      os: "macos aarch64",
      git: "/opt/homebrew/bin/git 2.56.1",
      workspace: { path: "/w", name: "w", device: "Laptop", remote: null },
    },
    [
      { id: 1, time, level: "info", source: "sync", message: "Sync started (interval)" },
      { id: 2, time, level: "warn", source: "sync", message: "Offline after 12 ms: no route" },
    ],
  );
  const lines = text.trimEnd().split("\n");
  expect(lines[0]).toBe("Document Collab Tool 0.1.0 (debug build) on macos aarch64");
  expect(lines[1]).toBe("Git: /opt/homebrew/bin/git 2.56.1");
  expect(lines[2]).toBe('Workspace: /w · device "Laptop" · remote none');
  expect(lines.slice(-2)).toEqual([
    "09:41:02.007 INFO  [sync] Sync started (interval)",
    "09:41:02.007 WARN  [sync] Offline after 12 ms: no route",
  ]);
});
