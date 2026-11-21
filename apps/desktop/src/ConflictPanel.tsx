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
        {conflicts.length === 1 ? "This page has a conflict" : `This page has ${conflicts.length} conflicts`}
      </h2>
      <p className="muted">
        The same lines were changed in two places before they synced, so both versions were kept. Choose one, or edit
        the page below to combine them.
      </p>
      {conflicts.map((conflict, i) => (
        <div className="conflict" key={i}>
          {conflicts.length > 1 && <h3>Conflict {i + 1}</h3>}
          <div className="versions">
            {conflict.versions.map((version, v) => (
              <div className="version" key={v}>
                <div className="version-label">{version.label}</div>
                <pre className="version-text">{version.text || <em className="muted">(deleted)</em>}</pre>
                <button className="button" disabled={busy} onClick={() => onKeep(i, v)}>
                  Keep this version
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
