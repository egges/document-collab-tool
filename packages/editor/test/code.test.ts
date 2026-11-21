import { describe, expect, test } from "vitest";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { type PageEditor, createPageEditor, detectLanguage } from "../src/index.ts";

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
      expect(editor.save()).toBe("Intro\n\n```\ndef greet(name):\n    return name\n```\n".replace("    ", ""));
      cursorAt(view, 1); // into "Intro"
      expect(editor.save()).toBe("Intro\n\n```python\ndef greet(name):\nreturn name\n```\n");
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
  test("Enter keeps the indentation and Tab indents", async () => {
    await withEditor("```js\nif (x) {\n```\n", (editor, view) => {
      cursorAt(view, codeStart(view) + "if (x) {".length);
      press(view, "Enter");
      press(view, "Tab");
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
      expect(view.dom.querySelector<HTMLSelectElement>(".page-code-language")!.selectedOptions[0].text).toBe("SQL (auto)");
    });
  });

  test("the picker sets the language", async () => {
    await withEditor("```\nx\n```\n", (editor, view) => {
      const select = view.dom.querySelector<HTMLSelectElement>(".page-code-language")!;
      select.value = "rust";
      select.dispatchEvent(new Event("change"));
      expect(editor.save()).toBe("```rust\nx\n```\n");
    });
  });

  test("a language we don't know is kept and shown", async () => {
    await withEditor("```mermaid\ngraph TD\n```\n", (editor, view) => {
      const select = view.dom.querySelector<HTMLSelectElement>(".page-code-language")!;
      expect(select.value).toBe("mermaid");
      expect(editor.save()).toBeNull();
    });
  });

  test("fence aliases show as their language", async () => {
    await withEditor("```ts\nconst x = 1;\n```\n", (editor, view) => {
      expect(view.dom.querySelector<HTMLSelectElement>(".page-code-language")!.value).toBe("typescript");
      expect(editor.save()).toBeNull();
    });
  });
});
