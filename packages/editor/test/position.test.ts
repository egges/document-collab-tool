import { describe, expect, test } from "vitest";
import { MENU_GAP, WINDOW_MARGIN, placeMenu } from "../src/react/position.ts";

const window = { width: 1000, height: 800 };
const menu = { width: 220, height: 320 };
const lineAt = (top: number, left = 100) => ({ left, top, bottom: top + 20 });

describe("placing a menu inside the window", () => {
  test("below the line when it fits", () => {
    expect(placeMenu(lineAt(100), menu, window)).toEqual({ left: 100, top: 120 + MENU_GAP, maxHeight: null });
  });

  test("above the line near the bottom of the window", () => {
    const place = placeMenu(lineAt(700), menu, window);
    expect(place).toEqual({ left: 100, top: 700 - MENU_GAP - 320, maxHeight: null });
  });

  test("shifted left near the right edge", () => {
    expect(placeMenu(lineAt(100, 900), menu, window).left).toBe(1000 - WINDOW_MARGIN - 220);
  });

  test("never off the left edge, even in a window narrower than the menu", () => {
    expect(placeMenu(lineAt(100, 50), menu, { width: 200, height: 800 }).left).toBe(WINDOW_MARGIN);
  });

  test("shorter, where there is more room, when it fits neither below nor above", () => {
    const small = { width: 1000, height: 400 };
    // More room below: below, as tall as that room.
    expect(placeMenu(lineAt(100), menu, small)).toEqual({
      left: 100,
      top: 120 + MENU_GAP,
      maxHeight: 400 - WINDOW_MARGIN - 120 - MENU_GAP,
    });
    // More room above: above, from the window's top margin down to the line.
    expect(placeMenu(lineAt(250), menu, small)).toEqual({ left: 100, top: WINDOW_MARGIN, maxHeight: 250 - MENU_GAP - WINDOW_MARGIN });
  });
});
