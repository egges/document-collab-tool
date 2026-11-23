// "Aa" in the page's title bar: how pages look. Text size and width belong to
// the open page (they sync with it); the font is for every page on this
// device (pageFont.ts).
import { useCallback, useRef, useState } from "react";
import { ALargeSmall, Check } from "lucide-react";
import type { PageDisplay, PageDisplayKey } from "./api.ts";
import { onMenuKeyDown, useDismiss } from "./menu.ts";
import { PAGE_FONTS, type PageFont, pageFont } from "./pageFont.ts";
import { Switch } from "./Switch.tsx";

const TEXT_SIZES: { value: PageDisplay["textSize"]; label: string; sample: number }[] = [
  { value: "small", label: "Small", sample: 12 },
  { value: null, label: "Default", sample: 15 },
  { value: "large", label: "Large", sample: 18 },
];

export function PageStyleMenu({
  display,
  onChange,
}: {
  /** The open page's options; null while it loads. */
  display: PageDisplay | null;
  onChange: <K extends PageDisplayKey>(key: K, value: PageDisplay[K]) => void;
}) {
  const font = pageFont.use();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);
  useDismiss(root, open, close);

  return (
    <div className="font-menu-root" ref={root}>
      <button
        ref={trigger}
        className="icon-button"
        title="Page style"
        aria-label="Page style"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ALargeSmall size={17} />
      </button>
      {open && (
        <div className="menu font-menu" role="menu" aria-label="Page style" onKeyDown={onMenuKeyDown}>
          <div className="font-menu-title">This page</div>
          <div className="style-row">
            <span>Text size</span>
            <div className="segmented" role="group" aria-label="Text size">
              {TEXT_SIZES.map((size) => {
                const on = (display?.textSize ?? null) === size.value;
                return (
                  <button
                    key={size.label}
                    role="menuitemradio"
                    aria-checked={on}
                    aria-label={size.label}
                    title={size.label}
                    autoFocus={on}
                    disabled={!display}
                    className={"segment" + (on ? " selected" : "")}
                    onClick={() => onChange("textSize", size.value)}
                  >
                    <span style={{ fontSize: size.sample }}>A</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="style-row">
            <span id="full-width-label">Full width</span>
            <Switch
              role="menuitemcheckbox"
              labelledBy="full-width-label"
              checked={display?.width === "full"}
              disabled={!display}
              onChange={(on) => onChange("width", on ? "full" : null)}
            />
          </div>
          <div className="menu-separator" role="separator" />
          <div className="font-menu-title">
            Font <span className="font-menu-scope">· every page on this device</span>
          </div>
          <FontChoices font={font} onChoose={pageFont.set} inMenu />
        </div>
      )}
    </div>
  );
}

/** The four faces as "Ag" tiles, the chosen one marked. Also in Settings. */
export function FontChoices({
  font,
  onChoose,
  inMenu,
}: {
  font: PageFont;
  onChoose: (font: PageFont) => void;
  /** In a menu: menu items, for the arrow keys. */
  inMenu?: boolean;
}) {
  return (
    <div className="font-choices" role={inMenu ? "group" : "radiogroup"} aria-label="Page font">
      {PAGE_FONTS.map((f) => (
        <button
          key={f.id}
          role={inMenu ? "menuitemradio" : "radio"}
          aria-checked={f.id === font}
          className={"font-choice" + (f.id === font ? " selected" : "")}
          title={f.hint}
          onClick={() => onChoose(f.id)}
        >
          <span className={`font-sample font-${f.id}`}>Ag</span>
          <span className="font-label">{f.label}</span>
          {f.id === font && <Check size={12} className="font-check" aria-hidden />}
        </button>
      ))}
    </div>
  );
}
