// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { keepOpenToggles, readOpenToggles } from "./openToggles.ts";

describe("open toggles", () => {
  beforeEach(() => localStorage.clear());

  it("are kept per page", () => {
    keepOpenToggles("a", ["0:Steps", "1:Steps"]);
    expect(readOpenToggles("a")).toEqual(["0:Steps", "1:Steps"]);
    expect(readOpenToggles("b")).toEqual([]);
  });

  it("leave nothing behind when none are open", () => {
    keepOpenToggles("a", ["0:Steps"]);
    keepOpenToggles("a", []);
    expect(localStorage.length).toBe(0);
  });

  it("ignore what isn't a list of keys", () => {
    localStorage.setItem("sawmill.toggles.a", "{not json");
    expect(readOpenToggles("a")).toEqual([]);
    localStorage.setItem("sawmill.toggles.a", '["0:A", 3]');
    expect(readOpenToggles("a")).toEqual(["0:A"]);
  });
});
