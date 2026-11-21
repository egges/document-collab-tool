import type { Conflict } from "./api.ts";

/**
 * The conflict blocks in a page, each with a "keep this version" action.
 * The blocks also show in the editor (as marked lines), so they can be
 * merged by hand instead: edit the text and delete the markers.
 */
export function ConflictPanel({
  conflicts,
  busy,
  onKeep,
}: {
  conflicts: Conflict[];
  busy: boolean;
  onKeep: (index: number, version: number) => void;
}) {
  if (!conflicts.length) return null;
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
                <div className="version-label">{version.label}</div>
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
