import { expect, test } from "vitest";
import { otherWorkspaces } from "./Welcome.tsx";

test("the welcome screen offers every known workspace but the open one", () => {
  const entry = (path: string, current = false) => ({ path, name: path, missing: false, current, lastOpened: 0 });
  expect(otherWorkspaces([entry("a", true), entry("b"), entry("c")]).map((e) => e.path)).toEqual(["b", "c"]);
});
