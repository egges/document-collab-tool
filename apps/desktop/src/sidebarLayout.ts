// The sidebar's width and whether it's shown. Kept per device (in the
// window's local storage), not in the workspace: it's how this screen is set
// up, not something to sync.
import { useCallback, useEffect, useState } from "react";

export const SIDEBAR_WIDTH = { min: 180, default: 260, max: 520 } as const;

const KEY = "sidebar";

interface Layout {
  width: number;
  hidden: boolean;
}

export function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH.default;
  return Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)));
}

function load(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { width: clampWidth(saved.width ?? SIDEBAR_WIDTH.default), hidden: saved.hidden === true };
  } catch {
    return { width: SIDEBAR_WIDTH.default, hidden: false };
  }
}

export function useSidebarLayout() {
  const [layout, setLayout] = useState(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(layout));
    } catch {
      // Not saved: it resets on the next start, nothing worse.
    }
  }, [layout]);
  return {
    ...layout,
    setWidth: useCallback((width: number) => setLayout((l) => ({ ...l, width: clampWidth(width) })), []),
    toggle: useCallback(() => setLayout((l) => ({ ...l, hidden: !l.hidden })), []),
  };
}
