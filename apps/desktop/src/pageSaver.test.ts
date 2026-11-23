import { describe, expect, test, vi } from "vitest";
import type { Page, WriteResult } from "./api.ts";
import { type EditorLike, PageSaver, type SaverEvent } from "./pageSaver.ts";

/** Mimics packages/editor: save() is null until the content changes from what was loaded or saved. */
class FakeEditor implements EditorLike {
  content: string;
  private saved: string;
  private pending: string | null = null;
  refuse = false;
  constructor(markdown: string) {
    this.content = this.saved = markdown;
  }
  type(text: string) {
    this.content += text;
  }
  save() {
    if (this.refuse) throw Object.assign(new Error("would lose text"), { name: "SaveRefusedError" });
    if (this.content === this.saved) return null;
    this.pending = this.content;
    return this.content;
  }
  markSaved() {
    if (this.pending !== null) this.saved = this.pending;
    this.pending = null;
  }
  load(markdown: string) {
    this.content = this.saved = markdown;
    this.pending = null;
  }
}

/** A page on "disk" with the same merge rule as the Rust side, for line-append edits. */
class FakeDisk {
  writes: { base: string; body: string }[] = [];
  gone = false;
  constructor(public body: string) {}
  /** What happens between a write being sent and it finishing, e.g. the user typing. */
  during: () => void = () => {};
  write = async (base: string, body: string): Promise<WriteResult> => {
    this.writes.push({ base, body });
    this.during();
    this.during = () => {};
    if (this.gone) return { status: "gone" };
    if (this.body === base || this.body === body) {
      this.body = body;
      return { status: "written", conflicts: [] };
    }
    // Both sides only appended to base: keep both additions.
    this.body = base + body.slice(base.length) + this.body.slice(base.length);
    return { status: "merged", page: page(this.body) };
  };
}

function page(body: string): Page {
  return { id: "p", title: "P", body, conflicts: [], display: { width: null, textSize: null } };
}

function setup(body = "a\n") {
  const disk = new FakeDisk(body);
  const editor = new FakeEditor(body);
  const events: SaverEvent[] = [];
  const saver = new PageSaver({ base: body, write: disk.write, onEvent: (e) => events.push(e), delay: 10 });
  saver.attach(editor);
  return { disk, editor, events, saver };
}

describe("PageSaver", () => {
  test("writes edits against the version it read", async () => {
    const { disk, editor, saver } = setup();
    editor.type("b\n");
    await saver.flush();
    expect(disk.writes).toEqual([{ base: "a\n", body: "a\nb\n" }]);
    editor.type("c\n");
    await saver.flush();
    expect(disk.writes[1]).toEqual({ base: "a\nb\n", body: "a\nb\nc\n" });
    expect(disk.body).toBe("a\nb\nc\n");
  });

  test("doesn't write when nothing changed", async () => {
    const { disk, saver } = setup();
    await saver.flush();
    expect(disk.writes).toEqual([]);
  });

  test("saves shortly after the last change", async () => {
    vi.useFakeTimers();
    try {
      const { disk, editor, saver } = setup();
      editor.type("b\n");
      saver.changed();
      await vi.advanceTimersByTimeAsync(5);
      saver.changed(); // still typing
      await vi.advanceTimersByTimeAsync(5);
      expect(disk.writes).toEqual([]);
      await vi.advanceTimersByTimeAsync(10);
      expect(disk.body).toBe("a\nb\n");
    } finally {
      vi.useRealTimers();
    }
  });

  test("shows a newer version from disk when there are no unsaved edits", async () => {
    const { editor, events, saver } = setup();
    await saver.refresh(page("a\nfrom elsewhere\n"));
    expect(editor.content).toBe("a\nfrom elsewhere\n");
    expect(events).toContainEqual({ kind: "conflicts", conflicts: [] });
  });

  test("merges unsaved edits with a newer version instead of dropping either", async () => {
    const { disk, editor, saver } = setup();
    editor.type("mine\n");
    disk.body = "a\ntheirs\n"; // a sync pulled this in
    await saver.refresh(page(disk.body));
    expect(disk.body).toBe("a\nmine\ntheirs\n");
    expect(editor.content).toBe("a\nmine\ntheirs\n");
    // And later edits build on the merged version.
    editor.type("more\n");
    await saver.flush();
    expect(disk.writes.at(-1)).toEqual({ base: "a\nmine\ntheirs\n", body: "a\nmine\ntheirs\nmore\n" });
  });

  test("keeps what the user typed while a merging write was in flight", async () => {
    const { disk, editor, saver } = setup();
    editor.type("mine\n");
    disk.body = "a\ntheirs\n";
    disk.during = () => editor.type("typing\n");
    await saver.flush(); // merges; the editor still lacks "theirs"
    expect(editor.content).toBe("a\nmine\ntyping\n");
    await saver.flush(); // merges again, now nothing new was typed, so it shows the result
    expect(disk.body).toBe("a\nmine\ntyping\ntheirs\n");
    expect(editor.content).toBe(disk.body);
  });

  test("stops saving a page another device deleted", async () => {
    const { disk, editor, events, saver } = setup();
    disk.gone = true;
    editor.type("b\n");
    await saver.flush();
    editor.type("c\n");
    await saver.flush();
    expect(disk.writes).toHaveLength(1);
    expect(events).toContainEqual({ kind: "gone" });
  });

  test("reports a refused save and writes nothing", async () => {
    const { disk, editor, events, saver } = setup();
    editor.type("b\n");
    editor.refuse = true;
    await saver.flush();
    expect(disk.writes).toEqual([]);
    expect(events[0]).toMatchObject({ kind: "problem" });
    // Once the content can be saved again, it is.
    editor.refuse = false;
    await saver.flush();
    expect(disk.body).toBe("a\nb\n");
    expect(events.at(-1)).toEqual({ kind: "saved" });
  });

  test("applies a version that arrived before the editor was ready", async () => {
    const disk = new FakeDisk("a\n");
    const saver = new PageSaver({ base: "a\n", write: disk.write, onEvent: () => {} });
    await saver.refresh(page("a\nnewer\n"));
    const editor = new FakeEditor("a\n");
    saver.attach(editor);
    expect(editor.content).toBe("a\nnewer\n");
    editor.type("b\n");
    await saver.flush();
    expect(disk.writes[0].base).toBe("a\nnewer\n");
  });

  test("retries a failed write by itself", async () => {
    vi.useFakeTimers();
    try {
      const events: SaverEvent[] = [];
      let failures = 1;
      const writes: string[] = [];
      const write = async (_base: string, body: string): Promise<WriteResult> => {
        if (failures-- > 0) throw "disk full";
        writes.push(body);
        return { status: "written", conflicts: [] };
      };
      const editor = new FakeEditor("a\n");
      const saver = new PageSaver({ base: "a\n", write, onEvent: (e) => events.push(e), retryDelay: 100 });
      saver.attach(editor);
      editor.type("b\n");
      await saver.flush();
      expect(events).toEqual([{ kind: "problem", message: "disk full" }]);
      await vi.advanceTimersByTimeAsync(100);
      expect(writes).toEqual(["a\nb\n"]);
      expect(events.at(-1)).toEqual({ kind: "saved" });
    } finally {
      vi.useRealTimers();
    }
  });
});
