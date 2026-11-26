import { type Reader, versionTitle } from "@pagemesh/editor";
import type { Conflict } from "./api.ts";

/**
 * Above a page where two devices edited the same text. The page itself
 * shows each such place as a block with both versions and buttons to keep
 * one (packages/editor), so this is one line that says so and jumps to the
 * first.
 *
 * `listed` is for the rare page whose file holds a conflict the editor
 * can't draw as a block, such as one inside a code block: then every
 * conflict in the file is listed here with a "Keep this one" action, as
 * read from the file. Those can be merged by hand in the page too: edit
 * the text and delete the markers.
 */
export function ConflictPanel({
  conflicts,
  inPage,
  listed,
  reader,
  busy,
  onKeep,
  onShow,
}: {
  /** The conflict blocks in the page's file. */
  conflicts: Conflict[];
  /** How many blocks the editor shows right now. */
  inPage: number;
  listed: boolean;
  /** Whose versions say "You". */
  reader: Reader;
  busy: boolean;
  onKeep: (index: number, version: number) => void;
  onShow: () => void;
}) {
  if (!listed || !conflicts.length) {
    if (!inPage) return null;
    return (
      <div className="conflict-notice" role="status">
        <span>
          {inPage === 1
            ? "Part of this page was edited in two places."
            : `${inPage} parts of this page were edited in two places.`}{" "}
          <span className="muted">Both versions are kept until you choose.</span>
        </span>
        <button className="button" onClick={onShow}>
          Show
        </button>
      </div>
    );
  }
  return (
    <section className="conflicts" aria-label="Conflicts">
      <h2>
        {conflicts.length === 1 ? "Edited in two places" : `${conflicts.length} parts were edited in two places`}
      </h2>
      <p className="muted">
        Both versions are kept. Pick one, or combine them in the page below.
      </p>
      {conflicts.map((conflict, i) => (
        <div className="conflict" key={i}>
          {conflicts.length > 1 && <h3>Part {i + 1}</h3>}
          <div className="versions">
            {conflict.versions.map((version, v) => (
              <div className="version" key={v}>
                <div className="version-label">
                  {versionTitle({ ...version, text: version.label }, reader)}
                </div>
                <pre className="version-text">{version.text || <em className="muted">(deleted)</em>}</pre>
                <button className="button" disabled={busy} onClick={() => onKeep(i, v)}>
                  Keep this one
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
