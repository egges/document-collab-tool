import { expect, test } from "vitest";
import { cloudNames, joinable, joinableInCloud, otherWorkspaces } from "./Welcome.tsx";

test("the welcome screen offers every known workspace but the open one", () => {
  const entry = (path: string, current = false) => ({ path, name: path, missing: false, current, lastOpened: 0 });
  expect(otherWorkspaces([entry("a", true), entry("b"), entry("c")]).map((e) => e.path)).toEqual(["b", "c"]);
});

test("GitHub workspaces this device already has aren't offered to join", () => {
  const known = [
    { path: "/a", name: "My Notes", missing: false, current: true, lastOpened: 0 },
    { path: "/b", name: "Gone", missing: true, current: false, lastOpened: 0 },
  ];
  const remote = (name: string) => ({ fullName: `ada/${name}`, name, cloneUrl: `https://github.com/ada/${name}.git` });
  expect(joinable([remote("my notes"), remote("Gone"), remote("Team")], known).map((r) => r.name)).toEqual([
    "Gone",
    "Team",
  ]);
});

test("cloud folders are named in a sentence", () => {
  expect(cloudNames(["Dropbox"])).toBe("Dropbox");
  expect(cloudNames(["iCloud Drive", "Dropbox"])).toBe("iCloud Drive or Dropbox");
  expect(cloudNames(["iCloud Drive", "Dropbox", "OneDrive"])).toBe("iCloud Drive, Dropbox or OneDrive");
});

test("workspaces in cloud folders this device already has aren't offered to join", () => {
  const known = [{ path: "/a", name: "My Notes", missing: false, current: false, lastOpened: 0 }];
  const found = (name: string) => ({ name, path: `/Dropbox/${name}.docsync`, cloud: "Dropbox" });
  expect(joinableInCloud([found("My Notes"), found("Team")], known).map((f) => f.name)).toEqual(["Team"]);
});
