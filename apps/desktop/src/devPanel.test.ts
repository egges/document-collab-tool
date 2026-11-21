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

test("highlights commands, timings, exit codes and outcomes without changing the text", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { Highlighted } = await import("./DevPanel.tsx");
  const html = (text: string) => renderToStaticMarkup(createElement(Highlighted, { text }));

  expect(html("git fetch -q origin → exit 128 (15012 ms): ssh: timed out")).toBe(
    '<span class="hl-command">git fetch</span> -q origin <span class="hl-bad">→ exit 128</span> ' +
      '<span class="hl-time">(15012 ms)</span>: ssh: timed out',
  );
  expect(html("Sync done in 59 ms: pulled changes, pushed")).toBe(
    'Sync done <span class="hl-time">in 59 ms</span>: <span class="hl-good">pulled changes</span>, ' +
      '<span class="hl-good">pushed</span>',
  );
  // "git" later in a message isn't a command.
  expect(html("Using git: git 2.56.1")).toBe("Using git: git 2.56.1");
  expect(html("plain text")).toBe("plain text");
});
