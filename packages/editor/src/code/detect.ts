// Guesses the language of a snippet, as Notion does when you paste code.
// highlight.js's own guessing is weak on short snippets (it calls most of
// them CSS), so this looks for each language's tell-tale signs first and
// only falls back to it for longer code.
import { lowlight } from "./languages.ts";

type Sign = [pattern: RegExp, weight: number];

/**
 * Signs of each language, with how strongly they point to it. Ordered so
 * that when scores tie, the more common language wins.
 */
const SIGNS: Record<string, Sign[]> = {
  python: [
    [/^\s*def \w+\(.*\)\s*(->\s*[\w[\], .]+)?:\s*$/m, 4],
    [/^\s*class \w+(\(.*\))?:\s*$/m, 4],
    [/^\s*(from [\w.]+ )?import [\w.]+(, \w+)*( as \w+)?\s*$/m, 2],
    [/^\s*(if|elif|for|while|with|try|except)\b.*:\s*$/m, 2],
    [/\bprint\(/, 2],
    [/\b(self|None|True|False)\b/, 1],
    [/^\s*@\w+/m, 1],
    [/__name__|__init__/, 3],
    [/^\s*#(?!include|!).*$/m, 0.5],
  ],
  typescript: [
    [/\binterface \w+(<.*>)? (extends [\w, <>]+ )?\{/, 4],
    [/\btype \w+(<.*>)? = /, 4],
    [/\b(const|let|var) \w+: [\w<>[\]|]+/, 3],
    [/\(\w+\??: (string|number|boolean|any|unknown|\w+\[\]|[A-Z]\w*)/, 3],
    [/\): (string|number|boolean|void|Promise<.*>|[A-Z]\w*)( \{|;)/, 3],
    [/\b(as const|implements|readonly|keyof|private |public )\b/, 2],
    [/^\s*import .* from ["'][^"']+["'];?$/m, 1],
  ],
  javascript: [
    [/\b(const|let|var) \w+ = /, 2],
    [/=>/, 1],
    [/\bfunction\s*\w*\s*\(/, 2],
    [/\b(console\.log|document\.|window\.|require\()/, 3],
    [/^\s*import .* from ["'][^"']+["'];?$/m, 2],
    [/^\s*export (default |const |function |class )/m, 2],
    [/===|!==/, 2],
    [/\bawait \w+/, 1],
  ],
  rust: [
    [/\bfn \w+(<.*>)?\(.*\)/, 3],
    [/\blet mut \w+/, 4],
    [/\b(println|format|vec|panic)!\(/, 4],
    [/\b(impl|pub fn|pub struct|pub enum|use \w+::)/, 3],
    [/&(mut )?(str|self)\b/, 2],
    [/\b(Option|Result|Some|None|Ok|Err)\b/, 1],
  ],
  go: [
    [/^package \w+\s*$/m, 5],
    [/\bfunc (\(\w+ \*?\w+\) )?\w+\(/, 4],
    [/\w+ := /, 2],
    [/\bfmt\.\w+/, 3],
    [/^import \($/m, 3],
  ],
  java: [
    [/\bpublic (static )?(final )?(class|interface|void|int|String)\b/, 3],
    [/\bSystem\.out\.print/, 5],
    [/^import java\./m, 5],
    [/@Override/, 3],
    [/\bString\[\] args/, 4],
  ],
  csharp: [
    [/^using System(\.\w+)*;$/m, 5],
    [/\bConsole\.Write(Line)?\(/, 5],
    [/^\s*namespace [\w.]+/m, 3],
    [/\{ get; (private )?set; \}/, 5],
  ],
  cpp: [
    [/\bstd::/, 4],
    [/#include <(iostream|vector|string|map|memory)>/, 5],
    [/\b(cout|cin) <</, 4],
    [/\btemplate\s*</, 3],
    [/\b(nullptr|auto&?) /, 1],
  ],
  c: [
    [/^#include [<"][\w./]+\.h[>"]/m, 4],
    [/\bint main\(/, 2],
    [/\b(printf|malloc|free|sizeof)\(/, 2],
  ],
  ruby: [
    [/^\s*def \w+[?!]?(\(.*\))?\s*$/m, 3],
    [/^\s*end\s*$/m, 2],
    [/\b(puts|require|attr_accessor|attr_reader) /, 3],
    [/\bdo \|\w+(, \w+)*\|/, 4],
    [/^\s*module \w+\s*$/m, 2],
  ],
  php: [
    [/<\?php/, 6],
    [/\$\w+\s*=/, 2],
    [/\$this->/, 4],
    [/\bfunction \w+\(\$/, 4],
    [/\becho /, 1],
  ],
  swift: [
    [/^import (UIKit|SwiftUI|Foundation)\s*$/m, 5],
    [/\bfunc \w+\(.*\) -> /, 3],
    [/\bguard let /, 4],
    [/\b(var|let) \w+: [A-Z]\w*/, 1],
  ],
  kotlin: [
    [/\bfun \w+\(/, 4],
    [/\bval \w+/, 2],
    [/\bdata class /, 4],
  ],
  sql: [
    [/\bSELECT\b[\s\S]+\bFROM\b/i, 5],
    [/\bINSERT INTO\b/i, 5],
    [/\bUPDATE \w+ SET\b/i, 5],
    [/\bDELETE FROM\b/i, 5],
    [/\bCREATE (TABLE|INDEX|VIEW|DATABASE)\b/i, 5],
    [/\b(WHERE|JOIN|GROUP BY|ORDER BY)\b/, 1],
  ],
  bash: [
    [/^#!\/(usr\/)?bin\/(env )?(ba|z)?sh/m, 6],
    [/^\s*\$ \w/m, 3],
    [
      /^\s*(sudo |npm |npx |pnpm |yarn |git |cd |ls|mkdir |rm |cp |mv |echo |cat |curl |wget |brew |apt(-get)? |pip3? |cargo |docker |kubectl |export |source |chmod |ssh |grep |tar |make\b|uv |go (run|build|get|install))/m,
      3,
    ],
    [/\s(&&|\|\|)\s|\s\|\s\w/, 1],
    [/^\s*(fi|done|esac)\s*$/m, 3],
    [/\$\{?\w+\}?/, 0.5],
  ],
  powershell: [
    [/\b(Get|Set|New|Remove|Write)-[A-Z]\w+/, 5],
    [/\$env:\w+/, 4],
  ],
  dockerfile: [[/^(FROM \S+|RUN |COPY |WORKDIR |CMD \[|ENTRYPOINT |EXPOSE \d)/m, 3]],
  yaml: [
    [/^[\w-]+:( .*)?$/m, 1],
    [/^\s+[\w-]+: .+$/m, 1],
    [/^\s*- [\w"']/m, 1],
    [/^---\s*$/m, 1],
  ],
  toml: [
    [/^\[[\w.-]+\]\s*$/m, 3],
    [/^[\w-]+ = (".*"|\d+|true|false|\[)/m, 2],
  ],
  css: [
    [/^\s*[.#]?[\w-]+([\s>+~]*[.#:]?[\w-]+)*\s*\{\s*$/m, 2],
    [/^\s*[\w-]+:\s*[^;{}]+;\s*$/m, 2],
    [/@media|@import|!important/, 3],
  ],
  diff: [
    [/^(\+\+\+|---) \S/m, 3],
    [/^@@ .* @@/m, 5],
  ],
  html: [
    [/^\s*<!DOCTYPE html/i, 6],
    [/<(html|head|body|div|span|p|a|ul|li|script|style)\b[^>]*>/, 3],
    [/<\/\w+>/, 1],
  ],
  xml: [[/^\s*<\?xml/, 6]],
  markdown: [
    [/^#{1,6} \w/m, 2],
    [/^\s*[-*] \[[ x]\] /m, 3],
    [/\[[^\]]+\]\([^)]+\)/, 2],
  ],
};

/** Grammars it's worth asking highlight.js about, when no signs are clear. */
const FALLBACK = ["python", "javascript", "typescript", "java", "go", "rust", "ruby", "php", "c", "cpp", "csharp", "kotlin", "swift"];

/** Below this, a snippet is too short to judge. */
const MIN_LENGTH = 8;

/**
 * The language `code` is most likely in (a language id, as in ```python),
 * or null when it's unclear. Only looks at the first few thousand characters.
 */
export function detectLanguage(code: string): string | null {
  const text = code.slice(0, 4000);
  if (text.trim().length < MIN_LENGTH) return null;

  const trimmed = text.trim();
  if (/^[{[]/.test(trimmed) && isJson(code)) return "json";

  let best: string | null = null;
  let bestScore = 0;
  for (const [id, signs] of Object.entries(SIGNS)) {
    let score = 0;
    for (const [pattern, weight] of signs) if (pattern.test(text)) score += weight;
    if (score > bestScore) {
      best = id;
      bestScore = score;
    }
  }
  // TypeScript's signs only add to JavaScript's.
  if (best === "javascript" && score("typescript", text) >= 2) best = "typescript";
  if (best === "yaml" && !looksLikeYaml(text)) best = null;
  if (best === "toml" && /\w\(/.test(text)) best = null; // calls: code, not config
  if (best && bestScore >= 2) return best;

  // Longer code without clear signs: let highlight.js judge, if it's sure.
  if (trimmed.length >= 60) {
    const result = lowlight.highlightAuto(text, { subset: FALLBACK });
    if (result.data?.language && (result.data.relevance ?? 0) >= 10) return result.data.language;
  }
  return null;
}

function score(id: string, text: string): number {
  return SIGNS[id].reduce((sum, [pattern, weight]) => sum + (pattern.test(text) ? weight : 0), 0);
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Most lines are `key: value` or list items, and nothing looks like code. */
function looksLikeYaml(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (lines.length < 2 || /[;{}()]\s*$/m.test(text)) return false;
  const yamlish = lines.filter((l) => /^\s*([\w"'-][\w "'.-]*:(\s|$)|- )/.test(l)).length;
  return yamlish / lines.length >= 0.7;
}
