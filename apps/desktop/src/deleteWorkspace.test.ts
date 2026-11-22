import { expect, test } from "vitest";
import { deletionSummary } from "./DeleteWorkspace.tsx";

const info = (over: Partial<Parameters<typeof deletionSummary>[0]> = {}) => ({
  name: "Notes",
  path: "/n",
  remote: "https://github.com/ada/Notes.git",
  githubRepo: "ada/Notes",
  unsynced: false,
  ...over,
});

test("deleting a synced workspace keeps it on GitHub", () => {
  expect(deletionSummary(info(), false)).toContain("stays on GitHub (ada/Notes)");
});

test("deleting the repo too says every device loses it", () => {
  expect(deletionSummary(info(), true)).toContain("every device loses it");
});

test("a workspace only on this device warns that the Trash has the only copy", () => {
  expect(deletionSummary(info({ remote: null, githubRepo: null, unsynced: true }), false)).toContain("only copy");
  expect(deletionSummary(info({ unsynced: true }), false)).toContain("haven't synced");
});
