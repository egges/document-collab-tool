import { describe, expect, test } from "vitest";
import { assetPath } from "./pageAssets.ts";

describe("assetPath", () => {
  test("a link in the page's text means a file in its folder", () => {
    expect(assetPath("p1", "assets/photo%201.png")).toBe("p1/assets/photo 1.png");
    expect(assetPath("p1", "./assets/a.png?v=2")).toBe("p1/assets/a.png");
  });

  test("a link to another page's assets goes there, but never outside pages/", () => {
    expect(assetPath("p1", "../p2/assets/a.png")).toBe("p2/assets/a.png");
    expect(assetPath("p1", "../../secret.png")).toBeNull();
  });

  test("addresses are loaded as they are", () => {
    expect(assetPath("p1", "https://example.com/a.png")).toBeNull();
    expect(assetPath("p1", "data:image/png;base64,xx")).toBeNull();
    expect(assetPath("p1", "/etc/a.png")).toBeNull();
  });
});
