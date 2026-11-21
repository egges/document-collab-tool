import { expect, test } from "vitest";
import { renameTo } from "./WorkspaceName.tsx";

test("renaming saves a new, non-empty name only", () => {
  expect(renameTo("  Team Notes ", "My Notes")).toBe("Team Notes");
  expect(renameTo("My Notes", "My Notes")).toBeNull();
  expect(renameTo(" My Notes ", "My Notes")).toBeNull();
  expect(renameTo("   ", "My Notes")).toBeNull();
});
