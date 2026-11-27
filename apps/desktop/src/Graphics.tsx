// Sawmill's mark, and the small drawings and badges that make the app feel
// friendly. Colours come from app.css (the `.art-*` classes), so they follow
// light and dark mode.
import { useId } from "react";

/** The Sawmill mark: three linked pages. The same drawing as assets/icon.svg. */
export function Logo({ size = 32 }: { size?: number }) {
  const id = useId();
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7c6cf6" />
          <stop offset="1" stopColor="#5b4bd8" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#${id})`} />
      <g stroke="#ffffff" strokeOpacity="0.55" strokeWidth="3" strokeLinecap="round">
        <path d="M20 23 L44 27 L30 44 Z" fill="none" strokeLinejoin="round" />
      </g>
      <rect x="11" y="12" width="18" height="22" rx="4.5" fill="#ffffff" />
      <rect x="35" y="16" width="18" height="22" rx="4.5" fill="#ffffff" />
      <rect x="21" y="33" width="18" height="22" rx="4.5" fill="#ffd47e" />
      <g stroke="#7c6cf6" strokeWidth="2.4" strokeLinecap="round">
        <path d="M15.5 19 H24.5 M15.5 24 H21.5" />
        <path d="M39.5 23 H48.5 M39.5 28 H45.5" />
      </g>
      <path d="M25.5 40 H34.5 M25.5 45 H31.5" stroke="#b7791f" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

/** "Sawmill" with its mark, for the welcome screen. */
export function Wordmark() {
  return (
    <div className="wordmark">
      <Logo size={28} />
      <span>Sawmill</span>
    </div>
  );
}

/** A few pages floating together, with sparkles: for empty states. */
export function PagesArt({ size = 168 }: { size?: number }) {
  return (
    <svg className="art" width={size} height={(size * 120) / 168} viewBox="0 0 168 120" aria-hidden>
      <ellipse className="art-blob" cx="84" cy="64" rx="70" ry="50" />
      <path className="art-link" d="M56 46 C 76 30, 98 34, 112 50 M62 86 C 80 96, 104 92, 114 78" />
      <g transform="rotate(-8 56 60)">
        <rect className="art-page" x="34" y="32" width="46" height="58" rx="8" />
        <path className="art-line" d="M43 47 H70 M43 56 H66 M43 65 H70 M43 74 H58" />
      </g>
      <g transform="rotate(7 114 62)">
        <rect className="art-page art-page-warm" x="92" y="34" width="46" height="58" rx="8" />
        <path className="art-line art-line-warm" d="M101 49 H128 M101 58 H122 M101 67 H128" />
        <circle className="art-check" cx="128" cy="82" r="7" />
        <path className="art-check-mark" d="M124.8 82 l2.2 2.2 l4 -4.4" />
      </g>
      <path className="art-spark" d="M88 12 l2.2 5.8 l5.8 2.2 l-5.8 2.2 l-2.2 5.8 l-2.2 -5.8 l-5.8 -2.2 l5.8 -2.2 Z" />
      <path className="art-spark art-spark-small" d="M150 34 l1.4 3.6 l3.6 1.4 l-3.6 1.4 l-1.4 3.6 l-1.4 -3.6 l-3.6 -1.4 l3.6 -1.4 Z" />
      <circle className="art-dot" cx="22" cy="40" r="3" />
      <circle className="art-dot" cx="148" cy="100" r="2.5" />
    </svg>
  );
}

/** A hue from 0 to 359 for `name`, the same on every device. */
export function hueOf(name: string): number {
  let hash = 0;
  for (const ch of name.trim().toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return hash % 360;
}

/** The first letter of the workspace's name on a soft colour of its own. */
export function WorkspaceAvatar({ name, size = 20 }: { name: string; size?: number }) {
  const letter = [...name.trim()][0]?.toUpperCase() ?? "?";
  return (
    <span
      className="workspace-avatar"
      aria-hidden
      style={{ width: size, height: size, fontSize: size * 0.55, "--hue": hueOf(name) } as React.CSSProperties}
    >
      {letter}
    </span>
  );
}
