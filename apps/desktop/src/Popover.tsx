// A trigger with a menu under it: view tabs, a page's properties. The
// menu is fixed to the window, so a scrolling table or page can't clip it.
import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { onMenuKeyDown, useDismiss } from "./menu.ts";

export /** A trigger and a menu under it, fixed to the window; closes on Escape or a click outside. */
function Popover({
  label,
  trigger,
  children,
  open: controlled,
  onOpenChange,
}: {
  label: string;
  trigger: (toggle: () => void, open: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = onOpenChange ?? setOwn;
  const root = useRef<HTMLSpanElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const close = useCallback(() => setOpen(false), [setOpen]);
  useDismiss(root, open, close);

  useLayoutEffect(() => {
    const anchor = root.current?.firstElementChild;
    if (!open || !anchor) return setPlace(null);
    const r = anchor.getBoundingClientRect();
    setPlace({ left: Math.min(r.left, window.innerWidth - 260), top: r.bottom + 4 });
  }, [open]);

  return (
    <span ref={root} className="popover-root">
      {trigger(() => setOpen(!open), open)}
      {open && place && (
        <div
          className="menu db-column-menu"
          role="menu"
          aria-label={label}
          style={place}
          onKeyDown={(e) => {
            if (!(e.target instanceof HTMLInputElement)) onMenuKeyDown(e);
          }}
        >
          {children(close)}
        </div>
      )}
    </span>
  );
}
