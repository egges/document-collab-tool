import { CODE_BLOCK_KEYS, SHORTCUTS, keysLabel } from "./shortcuts.ts";

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
        <h2>Keyboard shortcuts</h2>
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
