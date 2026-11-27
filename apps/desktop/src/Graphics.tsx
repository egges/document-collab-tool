// Sawmill's mark, and the small drawings and badges that make the app feel
// friendly. Colours come from app.css (the `.art-*` classes), so they follow
// light and dark mode.
import { useId } from "react";
import { BLADE, HUB, SLOTS, SPARKLES, SPINNER, WORDMARK, WORDMARK_ORIGIN } from "./logoShapes.ts";

/** The ring, hub and slots, in `color`. */
function BladeDetails({ color }: { color: string }) {
  return (
    <g fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round">
      <circle cx={HUB.cx} cy={HUB.cy} r={HUB.ring} strokeWidth="8" />
      <circle cx={HUB.cx} cy={HUB.cy} r={HUB.hub} fill={color} stroke="none" />
      {SLOTS.map((d) => (
        <path key={d} d={d} strokeWidth="11" />
      ))}
    </g>
  );
}

/**
 * The mark's shapes, in the 412 × 414 box of brand/logo. Both versions are
 * drawn and app.css shows the one for the theme: on light, the details and
 * sparkles are Ink; on dark, the details are cut out of the blade and the
 * sparkles are Paper.
 */
function Mark({ sparkleClass }: { sparkleClass?: string }) {
  const cut = useId();
  return (
    <>
      <g className="logo-on-light">
        <path d={BLADE} fill="#fca311" />
        <BladeDetails color="#14213d" />
        {SPARKLES.map((d) => (
          <path key={d} d={d} fill="#14213d" className={sparkleClass} />
        ))}
      </g>
      <g className="logo-on-dark">
        <mask id={cut} maskUnits="userSpaceOnUse" x="0" y="0" width="412" height="414">
          <rect width="412" height="414" fill="#fff" />
          <BladeDetails color="#000" />
        </mask>
        <path d={BLADE} fill="#fca311" mask={`url(#${cut})`} />
        {SPARKLES.map((d) => (
          <path key={d} d={d} fill="#f7f7f2" className={sparkleClass} />
        ))}
      </g>
    </>
  );
}

/** The Sawmill mark: a saw blade with two sparkles. The same drawing as brand/logo/sawmill-mark-*.svg. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 412 414" aria-hidden>
      <Mark />
    </svg>
  );
}

/** The full logo, mark and "sawmill", for the welcome screen. */
export function Wordmark({ height = 32 }: { height?: number }) {
  return (
    <svg className="wordmark" height={height} viewBox="0 0 1605 414" role="img" aria-label="Sawmill">
      <Mark />
      <path
        className="wordmark-text"
        transform={`translate(${WORDMARK_ORIGIN.x},${WORDMARK_ORIGIN.y})`}
        d={WORDMARK}
      />
    </svg>
  );
}

/**
 * The spinning saw: Sawmill's sign that something is in progress
 * (brand/README.md). Amber, or the text's colour with `inherit`; app.css
 * turns it, slowly for people who asked for less motion.
 */
export function SawSpinner({ size = 16, inherit = false }: { size?: number; inherit?: boolean }) {
  const cut = useId();
  return (
    <svg
      className={"saw-spinner" + (inherit ? " saw-spinner-inherit" : "")}
      width={size}
      height={size}
      viewBox="0 0 400 400"
      aria-hidden
    >
      <mask id={cut} maskUnits="userSpaceOnUse" x="0" y="0" width="400" height="400">
        <rect width="400" height="400" fill="#fff" />
        <circle cx="200" cy="200" r={SPINNER.hub} fill="#000" />
        <g fill="none" stroke="#000" strokeWidth={SPINNER.slotWidth} strokeLinecap="round" strokeLinejoin="round">
          {SPINNER.slots.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
      </mask>
      <path d={SPINNER.blade} fill="currentColor" mask={`url(#${cut})`} />
    </svg>
  );
}

/**
 * For empty states: what a sawmill does. A rough page goes into the blade
 * and a finished one, checked off, comes out. The sparkles twinkle.
 */
export function PagesArt({ size = 168 }: { size?: number }) {
  return (
    <svg className="art" width={size} height={(size * 120) / 168} viewBox="0 0 168 120" aria-hidden>
      <ellipse className="art-blob" cx="84" cy="64" rx="74" ry="48" />
      <path className="art-link" d="M40 96 H128" />
      <g transform="rotate(-9 32 70)">
        <rect className="art-page art-page-rough" x="12" y="46" width="38" height="48" rx="6" />
        <path className="art-line" d="M20 59 H42 M20 67 H38 M20 75 H42" />
      </g>
      <svg x="50" y="24" width="68" height="68" viewBox="0 0 412 414">
        <Mark sparkleClass="art-spark" />
      </svg>
      <g transform="rotate(6 136 70)">
        <rect className="art-page art-page-done" x="116" y="46" width="38" height="48" rx="6" />
        <path className="art-line" d="M124 59 H146 M124 67 H142" />
        <circle className="art-check" cx="144" cy="84" r="6.5" />
        <path className="art-check-mark" d="M141 84 l2 2 l3.8 -4.2" />
      </g>
    </svg>
  );
}

/** How many soft colours workspace avatars choose from (app.css, `.workspace-avatar.tone-*`). */
const AVATAR_TONES = 5;

/** One of the avatar colours for `name`, the same on every device. */
export function toneOf(name: string): number {
  let hash = 0;
  for (const ch of name.trim().toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return hash % AVATAR_TONES;
}

/** The first letter of the workspace's name on a soft colour of its own. */
export function WorkspaceAvatar({ name, size = 20 }: { name: string; size?: number }) {
  const letter = [...name.trim()][0]?.toUpperCase() ?? "?";
  return (
    <span
      className={`workspace-avatar tone-${toneOf(name)}`}
      aria-hidden
      style={{ width: size, height: size, fontSize: size * 0.55 }}
    >
      {letter}
    </span>
  );
}
