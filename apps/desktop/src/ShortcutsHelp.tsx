import { Keyboard } from "lucide-react";
import { BLOCK_KEYS, CODE_BLOCK_KEYS, SHORTCUTS, keysLabel } from "./shortcuts.ts";

/** ⌘/: every shortcut. */
export function ShortcutsHelp({ devPanel, onClose }: { devPanel: boolean; onClose: () => void }) {
  const rows = Object.entries(SHORTCUTS).filter(([id]) => devPanel || !/^(toggleDevPanel|copyLog|filterLog)/.test(id));
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="dialog shortcuts"
        role="dialog"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        ref={(el) => el?.focus()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>
          <span className="dialog-icon" aria-hidden>
            <Keyboard size={16} />
          </span>
          Keyboard shortcuts
        </h2>
        <dl>
          {rows.map(([id, s]) => (
            <div key={id} className="shortcut-row">
              <dt>{s.label}</dt>
              <dd>
                <kbd>{keysLabel(s.keys)}</kbd>
              </dd>
            </div>
          ))}
          <div className="shortcut-row">
            <dt>Formatting and blocks</dt>
            <dd>
              select text, or type <kbd>/</kbd>
            </dd>
          </div>
        </dl>
        <h3>Blocks</h3>
        <dl>
          <div className="shortcut-row">
            <dt>Move a block, or open its menu</dt>
            <dd>drag or click ⋮⋮ left of it</dd>
          </div>
          {BLOCK_KEYS.map((k) => (
            <div key={k.label} className="shortcut-row">
              <dt>{k.label}</dt>
              <dd>
                {k.keys.map((keys) => (
                  <kbd key={keys}>{keysLabel(keys)}</kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
        <h3>In code blocks</h3>
        <dl>
          {CODE_BLOCK_KEYS.map((k) => (
            <div key={k.label} className="shortcut-row">
              <dt>{k.label}</dt>
              <dd>
                {k.typed ? <kbd>{k.typed}</kbd> : k.keys!.map((keys) => <kbd key={keys}>{keysLabel(keys)}</kbd>)}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
