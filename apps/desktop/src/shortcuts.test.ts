import { describe, expect, test } from "vitest";
import { SHORTCUTS, keysLabel, matches } from "./shortcuts.ts";

type Init = { code: string; key?: string; meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean };
const press = ({ code, key = "", meta = false, ctrl = false, shift = false, alt = false }: Init) =>
  ({ code, key, metaKey: meta, ctrlKey: ctrl, shiftKey: shift, altKey: alt }) as KeyboardEvent;

describe("matches", () => {
  test("⌘J on a Mac, Ctrl+J elsewhere", () => {
    expect(matches("mod+j", press({ code: "KeyJ", meta: true }), true)).toBe(true);
    expect(matches("mod+j", press({ code: "KeyJ", ctrl: true }), true)).toBe(false);
    expect(matches("mod+j", press({ code: "KeyJ", ctrl: true }), false)).toBe(true);
    expect(matches("mod+j", press({ code: "KeyJ", meta: true }), false)).toBe(false);
  });

  test("needs exactly the modifiers it names", () => {
    expect(matches("mod+j", press({ code: "KeyJ", meta: true, shift: true }), true)).toBe(false);
    expect(matches("mod+shift+j", press({ code: "KeyJ", meta: true, shift: true }), true)).toBe(true);
    expect(matches("mod+shift+j", press({ code: "KeyJ", meta: true }), true)).toBe(false);
  });

  test("uses the physical key, so ⌥ doesn't turn letters into symbols", () => {
    expect(matches("mod+alt+arrowup", press({ code: "ArrowUp", key: "ArrowUp", meta: true, alt: true }), true)).toBe(true);
    expect(matches("mod+/", press({ code: "Slash", key: "/", meta: true }), true)).toBe(true);
    expect(matches("mod+\\", press({ code: "Backslash", key: "\\", ctrl: true }), false)).toBe(true);
    expect(
      matches("mod+shift+backspace", press({ code: "Backspace", key: "Backspace", meta: true, shift: true }), true),
    ).toBe(true);
  });

  test("no two shortcuts share keys", () => {
    const keys = Object.values(SHORTCUTS).map((s) => s.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

test("labels", () => {
  expect(keysLabel("mod+shift+j", true)).toBe("⌘⇧J");
  expect(keysLabel("mod+shift+j", false)).toBe("Ctrl+Shift+J");
  expect(keysLabel("mod+alt+arrowdown", true)).toBe("⌘⌥↓");
  expect(keysLabel("mod+shift+backspace", false)).toBe("Ctrl+Shift+Backspace");
  expect(keysLabel("mod+\\", true)).toBe("⌘\\");
});
