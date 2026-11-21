// Developer panel: the live log of everything the app did, with filters and
// a Copy button for bug reports. Only in debug builds (or with
// DOCSYNC_DEV=1); toggle with ⌘⇧D / Ctrl+Shift+D.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type DevInfo, type LogEntry, type LogLevel, devApi, events } from "./api.ts";

/** Whether the panel is available, whether it's open, and the shortcut that toggles it. */
export function useDevPanel() {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    devApi
      .info()
      .then((info) => setEnabled(info.enabled))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled]);
  return { enabled, open, toggle: () => setOpen((o) => !o) };
}

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

/** Sources with their own colour; anything else is drawn neutral. */
const KNOWN_SOURCES = new Set(["app", "sync", "git", "save", "watch", "ui"]);
const sourceClass = (source: string) => (KNOWN_SOURCES.has(source) ? source : "other");

/**
 * Colours the parts of a message worth spotting at a glance: git commands,
 * timings, exit codes, and words for outcomes.
 */
const HIGHLIGHTS: [RegExp, string][] = [
  [/^git \S+/, "hl-command"],
  [/→ exit \d+|→ exit \?/, "hl-bad"],
  [/\(\d+ ms\)|\bin \d+ ms\b|\bafter \d+ ms\b/, "hl-time"],
  [/\b(?:failed|refused|Offline|deleted elsewhere|Permission denied)\b/, "hl-bad"],
  [/\b(?:merged?|conflicts? resolved|Resolved a conflict)\b/, "hl-merge"],
  [/\b(?:pushed|pulled changes|already up to date|Committed edits|Wrote page|Saved)\b/, "hl-good"],
];

export function Highlighted({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest) {
    // The earliest match of any pattern.
    let best: { index: number; length: number; cls: string } | null = null;
    for (const [pattern, cls] of HIGHLIGHTS) {
      const m = pattern.source.startsWith("^") && parts.length ? null : pattern.exec(rest);
      if (m && (!best || m.index < best.index)) best = { index: m.index, length: m[0].length, cls };
    }
    if (!best) {
      parts.push(rest);
      break;
    }
    if (best.index) parts.push(rest.slice(0, best.index));
    parts.push(
      <span key={key++} className={best.cls}>
        {rest.slice(best.index, best.index + best.length)}
      </span>,
    );
    rest = rest.slice(best.index + best.length);
  }
  return <>{parts}</>;
}

function time(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function line(e: LogEntry): string {
  return `${time(e.time)} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.message}`;
}

/** Everything someone debugging needs, as plain text. */
export function report(info: DevInfo | null, entries: LogEntry[]): string {
  const header = [
    `Document Collab Tool ${info?.version ?? "?"}${info?.debugBuild ? " (debug build)" : ""} on ${info?.os ?? "?"}`,
    `Git: ${info?.git ?? "not found"}`,
    info?.workspace
      ? `Workspace: ${info.workspace.path} · device "${info.workspace.device}" · remote ${info.workspace.remote ?? "none"}`
      : "Workspace: none open",
    `Copied: ${new Date().toISOString()} · ${entries.length} entries`,
    "",
  ];
  return [...header, ...entries.map(line)].join("\n") + "\n";
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Older WebViews: fall back to a hidden textarea.
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

export function DevPanel({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set()); // sources switched off
  const [levels, setLevels] = useState<Set<LogLevel>>(new Set(LEVELS));
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const [height, setHeight] = useState(() => Math.round(window.innerHeight * 0.4));
  const [maximized, setMaximized] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    let live: LogEntry[] = [];
    const unlisten = events.onDevLog((entry) => {
      live.push(entry);
      setEntries((now) => [...now, entry].slice(-5000));
    });
    devApi.entries().then((past) => {
      // Entries that arrived while loading are in both; keep each id once.
      const seen = new Set(past.map((e) => e.id));
      setEntries([...past, ...live.filter((e) => !seen.has(e.id))]);
      live = [];
    });
    return () => void unlisten.then((f) => f());
  }, []);

  const sources = useMemo(() => [...new Set(entries.map((e) => e.source))].sort(), [entries]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter(
      (e) =>
        !hidden.has(e.source) &&
        levels.has(e.level) &&
        (!q || e.message.toLowerCase().includes(q) || e.source.includes(q)),
    );
  }, [entries, hidden, levels, query]);

  // Follow new entries, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const toggle = <T,>(set: Set<T>, value: T) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const copy = async () => {
    const info = await devApi.info().catch(() => null);
    // Always everything, whatever the filters: the filters are for reading.
    await copyText(report(info, entries));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = height;
    const move = (m: MouseEvent) =>
      setHeight(Math.min(window.innerHeight - 80, Math.max(120, startHeight + startY - m.clientY)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <section
      className={"dev-panel" + (maximized ? " maximized" : "")}
      style={maximized ? undefined : { height }}
      aria-label="Developer log"
    >
      {!maximized && <div className="dev-resize" onMouseDown={startResize} />}
      <header
        className="dev-toolbar"
        onDoubleClick={(e) => {
          if (e.target === e.currentTarget) setMaximized(!maximized);
        }}
      >
        <strong>Developer log</strong>
        <div className="dev-chips">
          {sources.map((source) => (
            <button
              key={source}
              className={`dev-chip source-${sourceClass(source)}` + (hidden.has(source) ? "" : " on")}
              onClick={() => setHidden(toggle(hidden, source))}
            >
              {source}
            </button>
          ))}
          <span className="dev-sep" />
          {LEVELS.map((level) => (
            <button
              key={level}
              className={`dev-chip level-${level}` + (levels.has(level) ? " on" : "")}
              onClick={() => setLevels(toggle(levels, level))}
            >
              {level}
            </button>
          ))}
        </div>
        <input
          className="input dev-search"
          placeholder="Filter"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        <button className="button" onClick={() => void copy()} title="Copy the whole log, with app and workspace details">
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          className="button"
          onClick={() => {
            void devApi.clear();
            setEntries([]);
          }}
        >
          Clear
        </button>
        <button
          className="icon-button"
          aria-label={maximized ? "Restore size" : "Fill the window"}
          title={maximized ? "Restore size" : "Fill the window"}
          onClick={() => setMaximized(!maximized)}
        >
          {maximized ? "⤓" : "⤢"}
        </button>
        <button className="icon-button" aria-label="Close" title="Close (⌘⇧D)" onClick={onClose}>
          ×
        </button>
      </header>
      <div
        className="dev-list"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {shown.map((e) => (
          <div key={e.id} className={`dev-row level-${e.level}`}>
            <span className="dev-time">{time(e.time)}</span>
            <span className="dev-level">{e.level}</span>
            <span className={`dev-source source-${sourceClass(e.source)}`}>{e.source}</span>
            <span className="dev-message">
              <Highlighted text={e.message} />
            </span>
          </div>
        ))}
        {shown.length === 0 && <p className="muted dev-empty">Nothing logged{entries.length ? " that matches" : " yet"}.</p>}
      </div>
    </section>
  );
}
