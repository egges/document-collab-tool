import { expect, test } from "vitest";
import { accessAdvice, folderName, folderOfRemote, isFolderRemote, isGitHubRemote } from "./remotes.ts";

test("folder remotes are .docsync folders on this device, as on the Rust side", () => {
  expect(isFolderRemote("/Users/ada/Dropbox/Notes.docsync")).toBe(true);
  expect(isFolderRemote("/Users/ada/Dropbox/Notes.docsync/")).toBe(true);
  expect(isFolderRemote("file:///Users/ada/Dropbox/Notes.docsync")).toBe(true);
  expect(isFolderRemote("C:\\Users\\ada\\OneDrive\\Notes.docsync")).toBe(true);
  expect(isFolderRemote("https://github.com/ada/notes.git")).toBe(false);
  expect(isFolderRemote("/Volumes/USB/notes.git")).toBe(false);
  expect(isFolderRemote(null)).toBe(false);
});

test("a folder remote's folder and name", () => {
  expect(folderOfRemote("/Users/ada/Dropbox/Work/Notes.docsync/")).toBe("/Users/ada/Dropbox/Work");
  expect(folderOfRemote("C:\\Users\\ada\\OneDrive\\Notes.docsync")).toBe("C:\\Users\\ada\\OneDrive");
  expect(folderName("file:///Users/ada/Dropbox/Notes.docsync")).toBe("Notes.docsync");
});

test("GitHub remotes", () => {
  expect(isGitHubRemote("https://github.com/ada/notes.git")).toBe(true);
  expect(isGitHubRemote("git@github.com:ada/notes.git")).toBe(false);
  expect(isGitHubRemote("https://gitlab.com/ada/notes.git")).toBe(false);
  expect(isGitHubRemote(null)).toBe(false);
});

test("advice when the remote refuses this device", () => {
  const github = "https://github.com/ada/notes.git";
  expect(accessAdvice(github, null)).toMatchObject({ label: "Sign in to sync", action: "signIn" });
  const signedIn = accessAdvice(github, "ada");
  expect(signedIn.label).toBe("Can't sync");
  expect(signedIn.text).toContain("@ada");
  expect(accessAdvice("https://gitlab.com/ada/notes.git", null).action).toBe(null);
});
