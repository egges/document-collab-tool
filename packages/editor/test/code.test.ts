import { describe, expect, test } from "vitest";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { type PageEditor, createPageEditor, detectLanguage } from "../src/index.ts";
import { filterChoices } from "../src/code/view.ts";

const open = (markdown: string) => {
  const root = document.createElement("div");
  document.body.append(root);
  return createPageEditor({ root, markdown });
};

/** Types `text` one character at a time, the way a keyboard does (so input rules run). */
function typeKeys(view: EditorView, text: string) {
  for (const ch of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)));
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
  }
}

function press(view: EditorView, key: string, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, ...modifiers });
  return view.someProp("handleKeyDown", (f) => f(view, event)) ?? false;
}

function paste(view: EditorView, text: string) {
  view.dispatch(view.state.tr.insertText(text).setMeta("paste", true).setMeta("uiEvent", "paste"));
}

function cursorAt(view: EditorView, pos: number) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}

/** Position just inside the first code block. */
function codeStart(view: EditorView): number {
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === "code_block") at = pos + 1;
    return at < 0;
  });
  return at;
}

async function withEditor(markdown: string, run: (editor: PageEditor, view: EditorView) => void | Promise<void>) {
  const editor = await open(markdown);
  try {
    await run(editor, editor.view);
  } finally {
    await editor.destroy();
  }
}

describe("detecting the language", () => {
  test.each([
    ["python", "def greet(name):\n    return f'Hello {name}'"],
    ["python", "import os\nprint(os.getcwd())"],
    ["javascript", "const total = items.reduce((sum, x) => sum + x, 0);"],
    ["javascript", "console.log('hi')"],
    ["typescript", "interface User {\n  id: string;\n  name?: string;\n}"],
    ["typescript", "function add(a: number, b: number): number {\n  return a + b;\n}"],
    ["rust", 'fn main() {\n    println!("hi");\n}'],
    ["go", 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}'],
    ["java", "public class App {\n  public static void main(String[] args) {\n    System.out.println(1);\n  }\n}"],
    ["csharp", 'using System;\nConsole.WriteLine("hi");'],
    ["cpp", "#include <iostream>\nint main() { std::cout << 1; }"],
    ["c", '#include <stdio.h>\nint main() { printf("x"); }'],
    ["ruby", "class Dog\n  def bark\n    puts 'woof'\n  end\nend"],
    ["php", "<?php\necho $name;"],
    ["sql", "SELECT id, name FROM users WHERE active = 1;"],
    ["sql", "create table pages (id text primary key);"],
    ["bash", "npm install && npm test"],
    ["bash", "git commit -m 'Fix'"],
    ["bash", "#!/bin/bash\nset -e\necho done"],
    ["json", '{"name": "editor", "version": "1.0.0"}'],
    ["yaml", "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest"],
    ["html", '<div class="card">\n  <p>Hello</p>\n</div>'],
    ["css", ".card {\n  color: red;\n  padding: 4px;\n}"],
    ["dockerfile", "FROM node:22\nWORKDIR /app\nRUN npm ci"],
    ["diff", "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new"],
    ["toml", '[package]\nname = "docsync"\nversion = "0.1.0"'],
  ])("%s: %s", (language, code) => {
    expect(detectLanguage(code)).toBe(language);
  });

  test.each(["hello world", "Just some notes about the meeting.", "x", ""])("nothing for %j", (text) => {
    expect(detectLanguage(text)).toBeNull();
  });
});

describe("typing ```", () => {
  test("turns the line into a code block straight away", async () => {
    await withEditor("Intro\n", (editor, view) => {
      cursorAt(view, view.state.doc.content.size - 1);
      press(view, "Enter");
      typeKeys(view, "```");
      expect(view.state.selection.$from.parent.type.name).toBe("code_block");
      typeKeys(view, "ls -la");
      expect(editor.save()).toBe("Intro\n\n```\nls -la\n```\n");
    });
  });

  test("inline code still works", async () => {
    await withEditor("", (editor, view) => {
      typeKeys(view, "Run `npm test` now");
      expect(editor.save()).toBe("Run `npm test` now\n");
    });
  });
});

describe("automatic language", () => {
  test("is set when the cursor leaves the block", async () => {
    await withEditor("Intro\n\n```\n\n```\n", (editor, view) => {
      cursorAt(view, codeStart(view));
      typeKeys(view, "def greet(name):");
      press(view, "Enter");
      typeKeys(view, "return name");
      expect(editor.save()).toBe("Intro\n\n```\ndef greet(name):\n  return name\n```\n");
      cursorAt(view, 1); // into "Intro"
      expect(editor.save()).toBe("Intro\n\n```python\ndef greet(name):\n  return name\n```\n");
    });
  });

  test("is set straight away on paste", async () => {
    await withEditor("```\n\n```\n", (editor, view) => {
      cursorAt(view, codeStart(view));
      paste(view, "SELECT * FROM pages;");
      expect(editor.save()).toBe("```sql\nSELECT * FROM pages;\n```\n");
    });
  });

  test("is detected again after more edits, if it was detected", async () => {
    await withEditor("Intro\n\n```\n\n```\n", (editor, view) => {
      cursorAt(view, codeStart(view));
      paste(view, "x = 1\nprint(x)");
      expect(editor.save()).toContain("```python");
      cursorAt(view, view.state.doc.content.size - 2);
      // Replace it all with Rust.
      const start = codeStart(view);
      view.dispatch(view.state.tr.insertText('fn main() { println!("hi"); }', start, start + "x = 1\nprint(x)".length));
      cursorAt(view, 1);
      expect(editor.save()).toContain("```rust");
    });
  });

  test("never replaces a language picked by hand or written in the file", async () => {
    await withEditor("Intro\n\n```ruby\nputs 1\n```\n", (editor, view) => {
      cursorAt(view, codeStart(view));
      paste(view, "def f(x):\n    return x\n");
      cursorAt(view, 1);
      expect(editor.save()).toContain("```ruby");
    });
  });

  test("opening a page with unlabelled code changes nothing", async () => {
    await withEditor("Intro\n\n```\nSELECT 1 FROM t;\n```\n", (editor, view) => {
      cursorAt(view, codeStart(view) + 2);
      cursorAt(view, 1);
      expect(editor.save()).toBeNull();
    });
  });

  test("an undo takes back the typing, not just the language", async () => {
    await withEditor("Intro\n\n```\n\n```\n", (editor, view) => {
      cursorAt(view, codeStart(view));
      paste(view, "SELECT * FROM pages;");
      press(view, "z", { ctrlKey: true });
      expect(editor.save()).toBeNull();
    });
  });
});

describe("keys in code blocks", () => {
  test("Enter indents after an opening bracket and keeps the indentation", async () => {
    await withEditor("```js\nif (x) {\n```\n", (editor, view) => {
      cursorAt(view, codeStart(view) + "if (x) {".length);
      press(view, "Enter");
      typeKeys(view, "go();");
      press(view, "Enter");
      typeKeys(view, "stop();");
      expect(editor.save()).toBe("```js\nif (x) {\n  go();\n  stop();\n```\n");
    });
  });

  test("Shift-Tab takes the indentation off every selected line", async () => {
    await withEditor("```\n  a\n  b\nc\n```\n", (editor, view) => {
      const start = codeStart(view);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start + 2, start + 7)));
      press(view, "Tab", { shiftKey: true });
      expect(editor.save()).toBe("```\na\nb\nc\n```\n");
    });
  });

  test("Backspace in an empty block makes it text again", async () => {
    await withEditor("```\n\n```\n", (_editor, view) => {
      cursorAt(view, codeStart(view));
      press(view, "Backspace");
      expect(view.state.doc.firstChild!.type.name).toBe("paragraph");
    });
  });

  // Found by keyboard.test.ts: joined to the paragraph above, the line breaks couldn't be saved.
  test("Backspace at the start of a block does nothing", async () => {
    await withEditor("Text.\n\n```\na\nb\n```\n", (editor, view) => {
      cursorAt(view, codeStart(view));
      press(view, "Backspace");
      expect(editor.save()).toBeNull();
    });
  });

  test("Down on the last line of the page's last block adds a line after it", async () => {
    await withEditor("```\nx\n```\n", (editor, view) => {
      cursorAt(view, codeStart(view) + 1);
      press(view, "ArrowDown");
      typeKeys(view, "After");
      expect(editor.save()).toBe("```\nx\n```\n\nAfter\n");
    });
  });

  test("Mod-A selects the code first", async () => {
    await withEditor("Intro\n\n```\nabc\n```\n", (_editor, view) => {
      cursorAt(view, codeStart(view) + 1);
      press(view, "a", { ctrlKey: true });
      const { from, to } = view.state.selection;
      expect(view.state.doc.textBetween(from, to)).toBe("abc");
    });
  });
});

describe("drawing code blocks", () => {
  test("code is highlighted without changing the page", async () => {
    await withEditor("```python\ndef f():\n    return None\n```\n", (editor, view) => {
      const keyword = view.dom.querySelector(".hljs-keyword");
      expect(keyword?.textContent).toBe("def");
      expect(editor.save()).toBeNull();
    });
  });

  test("unlabelled code is highlighted as what it looks like", async () => {
    await withEditor("```\nSELECT id FROM users;\n```\n", (_editor, view) => {
      expect(view.dom.querySelector(".hljs-keyword")?.textContent).toBe("SELECT");
      expect(languageButton(view).textContent).toBe("SQLauto");
    });
  });

  test("the menu searches languages and sets one", async () => {
    await withEditor("```\nx\n```\n", (editor, view) => {
      languageButton(view).click();
      const input = view.dom.querySelector<HTMLInputElement>(".page-code-search input")!;
      expect(document.activeElement).toBe(input);
      input.value = "rs"; // a fence alias
      input.dispatchEvent(new Event("input"));
      expect(options(view)[0]).toBe("Rust");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      expect(editor.save()).toBe("```rust\nx\n```\n");
      expect(view.dom.querySelector(".page-code-menu")).toBeNull();
    });
  });

  test("the menu: arrow keys, clicking, and Escape", async () => {
    await withEditor("```\nx\n```\n", (editor, view) => {
      languageButton(view).click();
      const input = view.dom.querySelector<HTMLInputElement>(".page-code-search input")!;
      input.value = "script";
      input.dispatchEvent(new Event("input"));
      expect(options(view)).toEqual(["JavaScript", "TypeScript"]);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      expect(editor.save()).toBe("```typescript\nx\n```\n");

      languageButton(view).click();
      view.dom.querySelector<HTMLInputElement>(".page-code-search input")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(view.dom.querySelector(".page-code-menu")).toBeNull();

      languageButton(view).click();
      [...view.dom.querySelectorAll<HTMLElement>(".page-code-option")].find((o) => o.textContent?.startsWith("Go"))!.click();
      expect(editor.save()).toBe("```go\nx\n```\n");
    });
  });

  test("filterChoices ranks exact and prefix matches first", () => {
    const choices = ["JavaScript", "Java", "TypeScript"].map((label) => ({ value: label, label, names: [label.toLowerCase()] }));
    expect(filterChoices(choices, "java").map((c) => c.label)).toEqual(["Java", "JavaScript"]);
    expect(filterChoices(choices, "").length).toBe(3);
    expect(filterChoices(choices, "zzz")).toEqual([]);
  });

  test("a language we don't know is kept and shown", async () => {
    await withEditor("```mermaid\ngraph TD\n```\n", (editor, view) => {
      expect(languageButton(view).textContent).toBe("mermaid");
      languageButton(view).click();
      expect(options(view)).toContain("mermaid");
      expect(editor.save()).toBeNull();
    });
  });

  test("fence aliases show as their language", async () => {
    await withEditor("```ts\nconst x = 1;\n```\n", (editor, view) => {
      expect(languageButton(view).textContent).toBe("TypeScript");
      expect(editor.save()).toBeNull();
    });
  });
});

describe("editing like a code editor", () => {
  /** Opens a block with `text`; "|" marks the cursor, "[" and "]" a selection. */
  async function block(language: string, text: string, run: (view: EditorView, result: () => string) => void) {
    const plain = text.replace(/[|[\]]/g, "");
    await withEditor(`\`\`\`${language}\n${plain}\n\`\`\`\n`, (_editor, view) => {
      const start = codeStart(view);
      const cursor = text.indexOf("|");
      const from = cursor >= 0 ? cursor : text.indexOf("[");
      const to = cursor >= 0 ? cursor : text.indexOf("]") - 1;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start + from, start + to)));
      run(view, () => {
        const sel = view.state.selection;
        const code = view.state.doc.textBetween(start, start + view.state.selection.$from.parent.content.size, "\n");
        const a = sel.from - start;
        const b = sel.to - start;
        return a === b ? code.slice(0, a) + "|" + code.slice(a) : code.slice(0, a) + "[" + code.slice(a, b) + "]" + code.slice(b);
      });
    });
  }

  test("brackets and quotes come in pairs", async () => {
    await block("js", "|", (view, result) => {
      typeKeys(view, "f(");
      expect(result()).toBe("f(|)");
      typeKeys(view, "'a");
      expect(result()).toBe("f('a|')");
      typeKeys(view, "')"); // steps over the closers
      expect(result()).toBe("f('a')|");
    });
  });

  test("no pair in front of a word, or for an apostrophe", async () => {
    await block("js", "|word", (view, result) => {
      typeKeys(view, "(");
      expect(result()).toBe("(|word");
    });
    await block("text", "don|", (view, result) => {
      typeKeys(view, "'t");
      expect(result()).toBe("don't|");
    });
  });

  test("an opener typed over a selection wraps it", async () => {
    await block("js", "f([x])", (view, result) => {
      typeKeys(view, "[");
      expect(result()).toBe("f([[x]])");
    });
  });

  test("Backspace between an empty pair removes both", async () => {
    await block("js", "f(|)", (view, result) => {
      press(view, "Backspace");
      expect(result()).toBe("f|");
    });
  });

  test("Backspace in the indentation goes back one level", async () => {
    await block("js", "    |x", (view, result) => {
      press(view, "Backspace");
      expect(result()).toBe("  |x");
    });
  });

  test("Enter between brackets opens an indented line", async () => {
    await block("js", "if (x) {|}", (view, result) => {
      press(view, "Enter");
      expect(result()).toBe("if (x) {\n  |\n}");
    });
  });

  test("Enter after a colon indents in Python", async () => {
    await block("python", "def f():|", (view, result) => {
      press(view, "Enter");
      expect(result()).toBe("def f():\n  |");
    });
  });

  test("Home goes to the first character, then the line start", async () => {
    await block("js", "a\n    b|c", (view, result) => {
      press(view, "Home");
      expect(result()).toBe("a\n    |bc");
      press(view, "Home");
      expect(result()).toBe("a\n|    bc");
    });
  });

  test("End goes to the end of the line", async () => {
    await block("js", "a|b\nc", (view, result) => {
      press(view, "End");
      expect(result()).toBe("ab|\nc");
    });
  });

  test("Alt-arrows move lines", async () => {
    await block("js", "one\ntw|o\nthree", (view, result) => {
      press(view, "ArrowUp", { altKey: true });
      expect(result()).toBe("tw|o\none\nthree");
      press(view, "ArrowDown", { altKey: true });
      press(view, "ArrowDown", { altKey: true });
      expect(result()).toBe("one\nthree\ntw|o");
      press(view, "ArrowDown", { altKey: true }); // already last
      expect(result()).toBe("one\nthree\ntw|o");
    });
  });

  test("Shift-Alt-arrows copy lines", async () => {
    await block("js", "a|b\nc", (view, result) => {
      press(view, "ArrowDown", { altKey: true, shiftKey: true });
      expect(result()).toBe("ab\na|b\nc");
      press(view, "ArrowUp", { altKey: true, shiftKey: true });
      expect(result()).toBe("ab\na|b\nab\nc");
    });
  });

  test("Mod-/ comments lines out and back in", async () => {
    await block("python", "[if x:\n    y]", (view, result) => {
      press(view, "/", { ctrlKey: true });
      expect(result().replace(/[[\]]/g, "")).toBe("# if x:\n#     y");
      press(view, "/", { ctrlKey: true });
      expect(result().replace(/[[\]]/g, "")).toBe("if x:\n    y");
    });
    await block("ts", "  let a|", (view, result) => {
      press(view, "/", { ctrlKey: true });
      expect(result()).toBe("  // let a|");
    });
  });

  test("Mod-] and Mod-[ indent the line wherever the cursor is", async () => {
    await block("js", "a|b", (view, result) => {
      press(view, "]", { ctrlKey: true });
      expect(result()).toBe("  a|b");
      press(view, "[", { ctrlKey: true });
      expect(result()).toBe("a|b");
    });
  });

  test("Up on the first line of a block at the top adds a line before it", async () => {
    await withEditor("```\nx\n```\n", (editor, view) => {
      cursorAt(view, codeStart(view));
      press(view, "ArrowUp");
      typeKeys(view, "Before");
      expect(editor.save()).toBe("Before\n\n```\nx\n```\n");
    });
  });
});

function languageButton(view: EditorView) {
  return view.dom.querySelector<HTMLButtonElement>(".page-code-language")!;
}

function options(view: EditorView): string[] {
  return [...view.dom.querySelectorAll(".page-code-option > span:first-child")].map((o) => o.textContent!);
}
