// Conflict blocks: when two devices change the same lines of a page, sync
// keeps both versions in the page between markers (docsync's text_merge.rs):
//
//   <!-- sync-conflict:start -->
//   <!-- sync-conflict:version person="Anna Smith" person-id="5e6d7f803f9a1c2b" device="Laptop" device-id="3f9a1c2b" -->
//   Anna's version.
//   <!-- sync-conflict:version device="Desktop" -->
//   The other version.
//   <!-- sync-conflict:end -->
//
// The markers are HTML comments, each its own paragraph in the editor. Here
// they are found and drawn as one block: a bar that says what happened, a
// bar over each version that says who wrote it and on which device, and
// buttons to keep one version or both. Only decorations: the page's
// Markdown is the same as without them, and keeping a version is an edit
// like any other, which undo takes back.
//
// The rules for what counts as a block are docsync's (conflicts.rs): a
// start marker, at least one version marker before any other content, and
// an end marker; a block inside a version belongs to that version. Anything
// else is left as it is, because resolving a block we don't understand
// could lose text. The editor only draws blocks whose markers are top-level
// paragraphs, which is all sync writes outside code blocks.
import type { Node } from "@milkdown/kit/prose/model";
import { type EditorState, Plugin, PluginKey, Selection, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";

const START = "<!-- sync-conflict:start -->";
const END = "<!-- sync-conflict:end -->";
const VERSION_PREFIX = "<!-- sync-conflict:version ";

/** Who wrote a version, as its marker says. */
export interface VersionWriter {
  /** The person, if they were signed in. */
  person: string | null;
  /** What tells them apart from others with the same name, when known. */
  personId?: string | null;
  /** The device they wrote it on. */
  device: string | null;
  /** What tells the device apart from others with the same name, and stays when it's renamed. */
  deviceId?: string | null;
  /**
   * What the marker says when it names neither: "Changed elsewhere", or a
   * device's name in a block written before versions named people.
   */
  text: string | null;
}

/**
 * Who is reading the page: the person signed in on this device, if anyone,
 * and this device, each by name and by id. Versions are matched to the
 * reader by id; names only count for blocks written before versions had ids.
 */
export interface Reader {
  person: string | null;
  personId?: string | null;
  device: string | null;
  deviceId?: string | null;
}

export type ConflictMarker = { kind: "start" } | { kind: "end" } | { kind: "version"; writer: VersionWriter };

/** What a marker comment is, or null when `html` isn't one. */
export function parseMarker(html: string): ConflictMarker | null {
  const line = html.trimEnd();
  if (line === START) return { kind: "start" };
  if (line === END) return { kind: "end" };
  if (!line.startsWith(VERSION_PREFIX) || !line.endsWith("-->") || line.includes("\n")) return null;
  return { kind: "version", writer: parseWriter(line.slice(VERSION_PREFIX.length, -3)) };
}

/**
 * `person="…" device="…"`, either or both, each optionally with its `-id`;
 * other `key="value"` pairs are skipped. Anything else is plain text.
 */
function parseWriter(label: string): VersionWriter {
  const text = label.trim();
  const plain = { person: null, personId: null, device: null, deviceId: null, text };
  let person: string | null = null;
  let personId: string | null = null;
  let device: string | null = null;
  let deviceId: string | null = null;
  let rest = text;
  while (rest) {
    const equals = rest.indexOf('="');
    const close = equals < 0 ? -1 : rest.indexOf('"', equals + 2);
    if (close < 0) return plain;
    const key = rest.slice(0, equals);
    if (!/^[a-z-]+$/.test(key)) return plain;
    const value = rest.slice(equals + 2, close);
    if (key === "person") person = value;
    else if (key === "person-id") personId = value;
    else if (key === "device") device = value;
    else if (key === "device-id") deviceId = value;
    rest = rest.slice(close + 1).trimStart();
  }
  return person !== null || device !== null ? { person, personId, device, deviceId, text: null } : plain;
}

/** A name as a marker holds it (docsync's `version_marker` drops what could end the comment or the quotes early). */
function asWritten(name: string | null): string | null {
  if (name === null) return null;
  // eslint-disable-next-line no-control-regex
  return name.replaceAll("--", "-").replace(/[\u0000-\u001f\u007f-\u009f>]/g, "").replaceAll('"', "'").trim();
}

/**
 * Whether the reader wrote a version: it's by the person signed in here, or,
 * when it names no person, from this device. By id, so two people (or
 * devices) with the same name are never mixed up; by name only when the
 * version has no id, as in blocks written before versions had them.
 */
export function isReader(writer: VersionWriter, reader: Reader): boolean {
  const same = (id: string | null | undefined, readerId: string | null | undefined, name: string | null, readerName: string | null) =>
    id ? id === readerId : name !== null && name === asWritten(readerName);
  if (writer.person !== null || writer.personId) return same(writer.personId, reader.personId, writer.person, reader.person);
  return same(writer.deviceId, reader.deviceId, writer.device, reader.device);
}

/**
 * What to call a version: the person ("You" for the reader) and the device,
 * as in "You · MacBook Pro" or "Anna Smith · Laptop". Just the device when
 * nobody was signed in on it.
 */
export function versionTitle(writer: VersionWriter, reader: Reader): string {
  const who = isReader(writer, reader) ? "You" : writer.person;
  const parts = [who, writer.device].filter((part) => part);
  return parts.length ? parts.join(" · ") : (writer.text ?? "");
}

/** Positions in the document: `from` just before a block, `to` just after one. */
export interface Range {
  from: number;
  to: number;
}

export interface ConflictVersion {
  writer: VersionWriter;
  /** The paragraph that holds the version's marker. */
  marker: Range;
  /** The version's own blocks. Empty (`from` equals `to`) when that side deleted the text. */
  content: Range;
}

/** A conflict block: everything from its start marker to its end marker. */
export interface ConflictBlock extends Range {
  /** The paragraphs that hold the start and end markers. */
  start: Range;
  end: Range;
  versions: ConflictVersion[];
}

/** The marker in `node`, when it's a paragraph that holds a marker and nothing else. */
function markerIn(node: Node): ConflictMarker | null {
  if (node.type.name !== "paragraph" || node.childCount !== 1) return null;
  return markerOf(node.firstChild!);
}

function markerOf(node: Node): ConflictMarker | null {
  return node.type.name === "html" ? parseMarker(String(node.attrs.value)) : null;
}

/** The well-formed conflict blocks in the page, in order. Blocks inside another block's version aren't listed separately. */
export function findConflicts(doc: Node): ConflictBlock[] {
  const blocks: ConflictBlock[] = [];
  let open: { start: Range; versions: ConflictVersion[]; depth: number; malformed: boolean } | null = null;
  doc.forEach((node, pos) => {
    const marker = markerIn(node);
    const range = { from: pos, to: pos + node.nodeSize };
    if (!open) {
      if (marker?.kind === "start") open = { start: range, versions: [], depth: 0, malformed: false };
      return;
    }
    if (open.depth === 0 && marker?.kind === "end") {
      if (!open.malformed && open.versions.length) {
        blocks.push({ from: open.start.from, to: range.to, start: open.start, end: range, versions: open.versions });
      }
      open = null;
      return;
    }
    if (open.depth === 0 && marker?.kind === "version") {
      open.versions.push({ writer: marker.writer, marker: range, content: { from: range.to, to: range.to } });
      return;
    }
    if (marker?.kind === "start") open.depth += 1;
    else if (marker?.kind === "end") open.depth -= 1;
    const version = open.versions.at(-1);
    if (version) version.content.to = range.to;
    // Something between the start marker and the first version (an empty line doesn't count).
    else if (node.content.size > 0 || node.type.name !== "paragraph") open.malformed = true;
  });
  return blocks;
}

/**
 * Resolves a conflict block: keeps version `keep` in its place, or with
 * "both" every version one after another, and removes the markers and the
 * other versions.
 */
export function keepVersion(state: EditorState, block: ConflictBlock, keep: number | "both"): Transaction {
  const tr = state.tr;
  // What to remove, last first, so earlier positions stay right.
  const remove: Range[] = [];
  if (keep === "both") {
    remove.push(block.end, ...block.versions.map((v) => v.marker).reverse(), block.start);
  } else {
    const kept = block.versions[keep]?.content;
    if (!kept) return tr;
    if (kept.from === kept.to) remove.push(block);
    else remove.push({ from: kept.to, to: block.to }, { from: block.from, to: kept.from });
  }
  const all = remove.reduce((size, range) => size + range.to - range.from, 0);
  if (all === state.doc.content.size) {
    // Nothing else on the page: leave an empty line to type in.
    tr.replaceWith(0, state.doc.content.size, state.schema.nodes.paragraph.create());
    return tr.setSelection(TextSelection.create(tr.doc, 1));
  }
  for (const range of remove) tr.delete(range.from, range.to);
  return tr;
}

/** Each version's place in the page: `block` and `version` number them as `findConflicts` does. */
function versionAt(blocks: ConflictBlock[], markerPos: number): { block: ConflictBlock; version: number } | null {
  for (const block of blocks) {
    const version = block.versions.findIndex((v) => v.marker.from === markerPos);
    if (version >= 0) return { block, version };
  }
  return null;
}

interface ConflictState {
  blocks: ConflictBlock[];
  decorations: DecorationSet;
}

const key = new PluginKey<ConflictState>("page-conflicts");

/** The conflict blocks drawn in the page. */
export function conflictBlocks(state: EditorState): ConflictBlock[] {
  return key.getState(state)?.blocks ?? [];
}

/** Draw the labels again: the reader changed (signed in or out, or renamed the device). */
export function refreshConflicts(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(key, true).setMeta("addToHistory", false));
}

/** A button in a marker's bar. `act` gets the paragraph the button is in. */
function button(label: string, title: string, act: (view: EditorView, markerPos: number) => void) {
  return (view: EditorView, getPos: () => number | undefined) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "page-conflict-keep";
    el.textContent = label;
    el.title = title;
    // Keep the cursor where it is in the page.
    el.addEventListener("mousedown", (event) => event.preventDefault());
    el.addEventListener("click", (event) => {
      event.preventDefault();
      const pos = getPos();
      // The button sits just inside its paragraph.
      if (pos !== undefined) act(view, pos - 1);
    });
    return el;
  };
}

const keepThis = button("Keep this version", "Keep this version and remove the other", (view, markerPos) => {
  const found = versionAt(conflictBlocks(view.state), markerPos);
  if (found) view.dispatch(keepVersion(view.state, found.block, found.version));
});

const keepBoth = button("Keep both", "Keep both versions, one after the other", (view, markerPos) => {
  const block = conflictBlocks(view.state).find((b) => b.start.from === markerPos);
  if (block) view.dispatch(keepVersion(view.state, block, "both"));
});

function build(doc: Node, reader: Reader): ConflictState {
  const blocks = findConflicts(doc);
  const decorations: Decoration[] = [];
  const bar = (range: Range, kind: string, attrs: Record<string, string> = {}) =>
    decorations.push(Decoration.node(range.from, range.to, { class: `page-conflict-bar page-conflict-${kind}`, ...attrs }));
  const widget = (range: Range, name: string, toDOM: ReturnType<typeof button>) =>
    decorations.push(Decoration.widget(range.from + 1, toDOM, { side: -1, key: name, ignoreSelection: true, stopEvent: () => true }));

  for (const block of blocks) {
    bar(block.start, "start", {
      "data-label": block.versions.length === 2 ? "Edited in two places" : "Edited in several places",
      "data-note": "Keep one version, or edit them and keep both.",
    });
    widget(block.start, "conflict-keep-both", keepBoth);
    for (const version of block.versions) {
      const empty = version.content.from === version.content.to;
      bar(version.marker, "version", {
        "data-label": versionTitle(version.writer, reader),
        ...(empty ? { "data-note": "removed this text" } : {}),
      });
      widget(version.marker, "conflict-keep-version", keepThis);
      doc.nodesBetween(version.content.from, version.content.to, (node, pos) => {
        decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "page-conflict-body" }));
        return false; // top-level blocks only
      });
    }
    bar(block.end, "end");
  }
  return { blocks, decorations: DecorationSet.create(doc, decorations) };
}

/**
 * A marker shares its paragraph with something else, for example after
 * Backspace at the start of the text below it: put it back in a paragraph
 * of its own, so the block stays a block.
 */
function isolateMarkers(state: EditorState): Transaction | null {
  const splits = new Set<number>();
  state.doc.forEach((node, pos) => {
    if (node.type.name !== "paragraph" || node.childCount < 2) return;
    node.forEach((child, offset, index) => {
      if (!markerOf(child)) return;
      const at = pos + 1 + offset;
      if (index > 0) splits.add(at);
      if (index < node.childCount - 1) splits.add(at + child.nodeSize);
    });
  });
  if (!splits.size) return null;
  const tr = state.tr;
  for (const at of [...splits].sort((a, b) => b - a)) tr.split(at);
  return tr;
}

/**
 * The cursor never rests in a marker's bar, where typing would break the
 * block: it moves on to the text past the bar, in the direction it was
 * going.
 */
function leaveBars(state: EditorState, cameFrom: number): Transaction | null {
  const { selection, doc } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const inBar = (pos: number) => {
    const $pos = doc.resolve(pos);
    return $pos.depth === 1 && conflictBlocks(state).some((b) => b.from <= $pos.before(1) && $pos.after(1) <= b.to) && !!markerIn($pos.parent);
  };
  if (!inBar(selection.from)) return null;
  const forward = selection.from >= cameFrom;
  for (const direction of forward ? ([1, -1] as const) : ([-1, 1] as const)) {
    let pos = selection.from;
    // Bars can follow each other (the start bar, then the first version's).
    for (let steps = 0; steps < 8; steps++) {
      const $pos = doc.resolve(pos);
      const edge = doc.resolve(direction > 0 ? $pos.after(1) : $pos.before(1));
      const next = Selection.findFrom(edge, direction, true);
      if (!next) break;
      if (!inBar(next.from)) return state.tr.setSelection(next);
      pos = next.from;
    }
  }
  return null;
}

/** Draws conflict blocks. `reader` is asked each time they are drawn, for which versions are "You". */
export function conflictsPlugin(reader: () => Reader): Plugin {
  return new Plugin<ConflictState>({
    key,
    state: {
      init: (_config, state) => build(state.doc, reader()),
      apply: (tr, value) => (tr.docChanged || tr.getMeta(key) ? build(tr.doc, reader()) : value),
    },
    props: {
      decorations: (state) => key.getState(state)?.decorations,
    },
    appendTransaction(transactions, oldState, newState) {
      if (transactions.some((tr) => tr.docChanged)) {
        const isolated = isolateMarkers(newState);
        if (isolated) return isolated;
      }
      return leaveBars(newState, oldState.selection.from);
    },
  });
}
