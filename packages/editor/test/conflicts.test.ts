import { describe, expect, test } from "vitest";
import { joinBackward } from "@milkdown/kit/prose/commands";
import { undo } from "@milkdown/kit/prose/history";
import { TextSelection } from "@milkdown/kit/prose/state";
import {
  type PageEditor,
  type Reader,
  createPageEditor,
  findConflicts,
  isReader,
  keepVersion,
  parseMarker,
  versionTitle,
} from "../src/index.ts";

const START = "<!-- sync-conflict:start -->";
const END = "<!-- sync-conflict:end -->";
const version = (label: string) => `<!-- sync-conflict:version ${label} -->`;

// As sync writes a block, and as the editor saves it (every marker its own paragraph).
const RAW = `intro\n${START}\n${version('person="Anna Smith" device="Laptop"')}\nmine\n${version('device="Desktop"')}\ntheirs\nsecond line\n${END}\noutro\n`;
const SAVED = `intro\n\n${START}\n\n${version('person="Anna Smith" device="Laptop"')}\n\nmine\n\n${version('device="Desktop"')}\n\ntheirs\nsecond line\n\n${END}\n\noutro\n`;

const ANNA: Reader = { person: "Anna Smith", device: "Laptop" };

const open = (markdown: string, reader?: Reader) =>
  createPageEditor({ root: document.createElement("div"), markdown, reader });

/** Each block's versions as [label, text]. */
const versions = (editor: PageEditor) =>
  editor.conflicts.map((block) =>
    block.versions.map((v) => [
      versionTitle(v.writer, { person: null, device: null }),
      editor.view.state.doc.textBetween(v.content.from, v.content.to, "\n\n", "\n"),
    ]),
  );

describe("markers", () => {
  test("a version marker names the person and the device", () => {
    expect(parseMarker(START)).toEqual({ kind: "start" });
    expect(parseMarker(`${END}  `)).toEqual({ kind: "end" });
    expect(parseMarker(version('person="Anna Smith" device="Anna\'s MacBook Pro (2)"'))).toEqual({
      kind: "version",
      writer: { person: "Anna Smith", personId: null, device: "Anna's MacBook Pro (2)", deviceId: null, text: null },
    });
    expect(parseMarker(version('device="Laptop"'))).toEqual({
      kind: "version",
      writer: { person: null, personId: null, device: "Laptop", deviceId: null, text: null },
    });
    expect(parseMarker(version('person="Anna" person-id="github:1234" device="Mac" device-id="3f9a1c2b"'))).toEqual({
      kind: "version",
      writer: { person: "Anna", personId: "github:1234", device: "Mac", deviceId: "3f9a1c2b", text: null },
    });
    // Pairs this version doesn't know are skipped.
    expect(parseMarker(version('person="Anna" agent="Claude" device="Mac"'))).toEqual({
      kind: "version",
      writer: { person: "Anna", personId: null, device: "Mac", deviceId: null, text: null },
    });
  });

  test("any other label is plain text", () => {
    // The same cases as docsync's text_merge tests: both sides must agree.
    for (const text of ["Changed elsewhere", "Arjans-MacBook-Pro", "person=Anna", 'person="Anna', 'Person="Anna"', 'by person="Anna"', 'agent="Claude"']) {
      expect(parseMarker(version(text))).toEqual({
        kind: "version",
        writer: { person: null, personId: null, device: null, deviceId: null, text },
      });
    }
  });

  test("other comments are not markers", () => {
    for (const html of ["<!-- note -->", "<!-- sync-conflict:start -->x", `${START}\n${END}`, "<div>", "<!-- sync-conflict:version"]) {
      expect(parseMarker(html)).toBeNull();
    }
  });
});

describe("who wrote a version", () => {
  const by = (person: string | null, device: string | null) => ({ person, device, text: null });

  test("the reader's own versions say You, with the device", () => {
    expect(versionTitle(by("Anna Smith", "Laptop"), ANNA)).toBe("You · Laptop");
    // The same person on another device: the usual case.
    expect(versionTitle(by("Anna Smith", "Desktop"), ANNA)).toBe("You · Desktop");
    expect(versionTitle(by("Ben", "Laptop"), ANNA)).toBe("Ben · Laptop");
    expect(versionTitle(by("Ben", null), ANNA)).toBe("Ben");
  });

  test("without a person, a version from this device is the reader's", () => {
    expect(versionTitle(by(null, "Laptop"), ANNA)).toBe("You · Laptop");
    expect(versionTitle(by(null, "Laptop"), { person: null, device: "Laptop" })).toBe("You · Laptop");
    expect(versionTitle(by(null, "Desktop"), ANNA)).toBe("Desktop");
    expect(versionTitle(by(null, "Laptop"), { person: null, device: null })).toBe("Laptop");
  });

  test("names are compared as markers hold them", () => {
    const reader = { person: 'Dwayne "The Rock" --> J', device: "Mac" };
    expect(isReader(by("Dwayne 'The Rock' - J", "Other"), reader)).toBe(true);
    expect(isReader(by("Dwayne", "Mac"), reader)).toBe(false);
  });

  test("by id, people and devices with the same name are told apart", () => {
    const anna = { person: "Anna", personId: "github:1", device: "MacBook-Pro", deviceId: "aaa" };
    const otherAnna = { person: "Anna", personId: "github:2", device: "MacBook-Pro", deviceId: "bbb", text: null };
    expect(versionTitle(otherAnna, anna)).toBe("Anna · MacBook-Pro");
    expect(versionTitle({ ...otherAnna, personId: "github:1" }, anna)).toBe("You · MacBook-Pro");
    // Signed out: the device, by id, even though both have the same name.
    const signedOut = { person: null, personId: null, device: "MacBook-Pro", deviceId: "bbb", text: null };
    expect(versionTitle(signedOut, { ...anna, person: null, personId: null })).toBe("MacBook-Pro");
    expect(versionTitle({ ...signedOut, deviceId: "aaa" }, { ...anna, person: null, personId: null })).toBe("You · MacBook-Pro");
    // This device was renamed since: still yours.
    expect(versionTitle({ ...signedOut, device: "Old name", deviceId: "aaa" }, anna)).toBe("You · Old name");
    // An id the reader doesn't have (signed out) is never matched by name instead.
    expect(isReader({ ...otherAnna, personId: "github:1" }, { ...anna, personId: null })).toBe(false);
  });

  test("plain text is shown as it is", () => {
    expect(versionTitle({ person: null, device: null, text: "Changed elsewhere" }, ANNA)).toBe("Changed elsewhere");
    expect(versionTitle({ person: null, device: null, text: "Laptop" }, ANNA)).toBe("Laptop");
  });
});

describe("finding blocks", () => {
  test("finds a block as sync wrote it and as the editor saved it", async () => {
    for (const page of [RAW, SAVED]) {
      const editor = await open(page);
      expect(versions(editor)).toEqual([
        [
          ["Anna Smith · Laptop", "mine"],
          ["Desktop", "theirs\nsecond line"],
        ],
      ]);
      // Opening a page with a block doesn't change it.
      expect(editor.dirty).toBe(false);
      expect(editor.save()).toBeNull();
      await editor.destroy();
    }
  });

  test("a block inside a version belongs to that version", async () => {
    const inner = `${START}\n\n${version("A")}\n\na\n\n${version("B")}\n\nb\n\n${END}`;
    const editor = await open(`${START}\n\n${version("Laptop")}\n\n${inner}\n\n${version("Desktop")}\n\nnew\n\n${END}\n`);
    expect(editor.conflicts).toHaveLength(1);
    expect(versions(editor)[0].map(([label]) => label)).toEqual(["Laptop", "Desktop"]);
    editor.view.dispatch(keepVersion(editor.view.state, editor.conflicts[0], 0));
    // The inner block is a block now.
    expect(versions(editor)).toEqual([
      [
        ["A", "a"],
        ["B", "b"],
      ],
    ]);
    expect(editor.save()).toBe(`${inner}\n`);
    await editor.destroy();
  });

  test("leaves blocks it doesn't understand alone", async () => {
    const unterminated = `${START}\n\n${version("A")}\n\na\n`;
    const textBeforeVersion = `${START}\n\nstray\n\n${version("A")}\n\na\n\n${END}\n`;
    const noVersions = `${START}\n\n${END}\n`;
    const inCode = `\`\`\`\n${START}\n${version("A")}\na\n${END}\n\`\`\`\n`;
    for (const page of [unterminated, textBeforeVersion, noVersions, inCode, "plain\n"]) {
      const editor = await open(page);
      expect(editor.conflicts, page).toEqual([]);
      expect(editor.view.dom.querySelector(".page-conflict-bar"), page).toBeNull();
      await editor.destroy();
    }
  });

  test("finds every block on the page", async () => {
    const editor = await open(`${SAVED}\n${SAVED.replace("mine", "mine 2")}`);
    expect(editor.conflicts).toHaveLength(2);
    expect(findConflicts(editor.view.state.doc)).toEqual(editor.conflicts);
    await editor.destroy();
  });
});

describe("keeping a version", () => {
  test("keeps one version in place of the block", async () => {
    for (const [keep, text] of [[0, "mine"], [1, "theirs\nsecond line"]] as const) {
      const editor = await open(SAVED);
      editor.view.dispatch(keepVersion(editor.view.state, editor.conflicts[0], keep));
      expect(editor.conflicts).toEqual([]);
      expect(editor.save()).toBe(`intro\n\n${text}\n\noutro\n`);
      await editor.destroy();
    }
  });

  test("keeps both versions, one after the other", async () => {
    const editor = await open(SAVED);
    editor.view.dispatch(keepVersion(editor.view.state, editor.conflicts[0], "both"));
    expect(editor.save()).toBe("intro\n\nmine\n\ntheirs\nsecond line\n\noutro\n");
    await editor.destroy();
  });

  test("keeping a version that deleted the text removes the block", async () => {
    const page = `intro\n\n${START}\n\n${version("Laptop")}\n\n${version("Desktop")}\n\ntheirs\n\n${END}\n\noutro\n`;
    const editor = await open(page);
    expect(versions(editor)).toEqual([[["Laptop", ""], ["Desktop", "theirs"]]]);
    expect(editor.view.dom.querySelector(".page-conflict-version")?.getAttribute("data-note")).toBe("removed this text");
    editor.view.dispatch(keepVersion(editor.view.state, editor.conflicts[0], 0));
    expect(editor.save()).toBe("intro\n\noutro\n");
    await editor.destroy();
  });

  test("a page that was only the block is left with an empty line", async () => {
    const editor = await open(`${START}\n\n${version("Laptop")}\n\n${version("Desktop")}\n\ntheirs\n\n${END}\n`);
    editor.view.dispatch(keepVersion(editor.view.state, editor.conflicts[0], 0));
    expect(editor.view.state.doc.childCount).toBe(1);
    expect(editor.view.state.doc.textContent).toBe("");
    expect(editor.save()).toBe("");
    await editor.destroy();
  });

  test("resolves the block it was asked to", async () => {
    const editor = await open(`${SAVED}\n${SAVED.replace("mine", "mine 2")}`);
    editor.view.dispatch(keepVersion(editor.view.state, editor.conflicts[1], 0));
    expect(editor.conflicts).toHaveLength(1);
    expect(editor.save()).toBe(`${SAVED}\nintro\n\nmine 2\n\noutro\n`);
    await editor.destroy();
  });
});

describe("in the page", () => {
  const labels = (editor: PageEditor) =>
    [...editor.view.dom.querySelectorAll(".page-conflict-bar")].map((bar) => bar.getAttribute("data-label"));

  test("a block is drawn with a bar per version that says who wrote it", async () => {
    const editor = await open(SAVED, ANNA);
    expect(labels(editor)).toEqual(["Edited in two places", "You · Laptop", "Desktop", null]);
    const bodies = [...editor.view.dom.querySelectorAll(".page-conflict-body")].map((el) => el.textContent);
    expect(bodies).toEqual(["mine", "theirs second line"]);
    await editor.destroy();
  });

  test("the labels follow who is reading", async () => {
    const editor = await open(SAVED, ANNA);
    editor.setReader({ person: "Ben", device: "Tablet" });
    expect(labels(editor)).toEqual(["Edited in two places", "Anna Smith · Laptop", "Desktop", null]);
    // Signed out, and the device renamed.
    editor.setReader({ person: null, device: "Desktop" });
    expect(labels(editor)).toEqual(["Edited in two places", "Anna Smith · Laptop", "You · Desktop", null]);
    // Loading another version of the page keeps the reader.
    editor.load(SAVED.replace("mine", "mine again"));
    expect(labels(editor)).toEqual(["Edited in two places", "Anna Smith · Laptop", "You · Desktop", null]);
    expect(editor.dirty).toBe(false);
    await editor.destroy();
  });

  test("the buttons keep a version, and undo brings the block back", async () => {
    const editor = await open(SAVED, ANNA);
    const buttons = () => [...editor.view.dom.querySelectorAll<HTMLButtonElement>(".page-conflict-keep")];
    expect(buttons().map((b) => b.textContent)).toEqual(["Keep both", "Keep this version", "Keep this version"]);
    buttons()[2].click();
    expect(editor.save()).toBe("intro\n\ntheirs\nsecond line\n\noutro\n");
    expect(buttons()).toEqual([]);

    undo(editor.view.state, editor.view.dispatch);
    expect(editor.dirty).toBe(false);
    expect(labels(editor)).toHaveLength(4);
    buttons()[0].click();
    expect(editor.save()).toBe("intro\n\nmine\n\ntheirs\nsecond line\n\noutro\n");
    await editor.destroy();
  });

  test("Backspace at the start of a version doesn't pull its text into the bar", async () => {
    const editor = await open(SAVED);
    const { view } = editor;
    const start = editor.conflicts[0].versions[0].content.from + 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start)));
    expect(joinBackward(view.state, view.dispatch)).toBe(true);
    expect(versions(editor)[0][0]).toEqual(["Anna Smith · Laptop", "mine"]);
    expect(view.state.selection.$from.parent.textContent).toBe("mine");
    expect(editor.dirty).toBe(false);
    await editor.destroy();
  });

  test("the cursor steps over the bars", async () => {
    const editor = await open(SAVED);
    const { view } = editor;
    const block = editor.conflicts[0];
    const at = (pos: number) => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
    const here = () => view.state.selection.$from.parent.textContent;

    // Down from "intro" into the first bar: on to the first version.
    at(3);
    at(block.start.from + 1);
    expect(here()).toBe("mine");
    // Up from "theirs" into its bar: back to the end of "mine".
    at(block.versions[1].content.from + 1);
    at(block.versions[1].marker.from + 1);
    expect(here()).toBe("mine");
    // Up from "mine": over both bars to "intro".
    at(block.versions[0].marker.to - 1);
    expect(here()).toBe("intro");
    // Down from "theirs" into the last bar: on to "outro".
    at(block.versions[1].content.to - 1);
    at(block.end.from + 1);
    expect(here()).toBe("outro");
    expect(editor.dirty).toBe(false);
    await editor.destroy();
  });

  test("showConflict says whether there is one", async () => {
    const editor = await open(SAVED);
    expect(editor.showConflict()).toBe(true);
    editor.view.dispatch(keepVersion(editor.view.state, editor.conflicts[0], 0));
    expect(editor.showConflict()).toBe(false);
    await editor.destroy();
  });
});
