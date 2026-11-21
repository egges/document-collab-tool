// The languages code blocks know: what the language picker offers, what a
// fence like ```ts means, and the grammar that highlights it.
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dart from "highlight.js/lib/languages/dart";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import elixir from "highlight.js/lib/languages/elixir";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import haskell from "highlight.js/lib/languages/haskell";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import latex from "highlight.js/lib/languages/latex";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import objectivec from "highlight.js/lib/languages/objectivec";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

export const lowlight = createLowlight({
  bash, c, cpp, csharp, css, dart, diff, dockerfile, elixir, go, graphql, haskell, ini, java,
  javascript, json, kotlin, latex, lua, makefile, markdown, objectivec, php, powershell, python,
  r, ruby, rust, scala, scss, sql, swift, typescript, xml, yaml,
});

export interface Language {
  /** What we write after the fence, as in ```python. */
  id: string;
  label: string;
  /** The highlight.js grammar, or null for plain text. */
  grammar: string | null;
  /** Other fence names that mean this language. */
  aliases: string[];
}

const lang = (id: string, label: string, grammar: string | null = id, aliases: string[] = []): Language => ({
  id,
  label,
  grammar,
  aliases,
});

/** In the order the picker shows them. */
export const LANGUAGES: Language[] = [
  lang("text", "Plain text", null, ["plaintext", "txt", "plain"]),
  lang("bash", "Shell", "bash", ["sh", "shell", "zsh", "console"]),
  lang("c", "C", "c", ["h"]),
  lang("cpp", "C++", "cpp", ["c++", "cc", "cxx", "hpp"]),
  lang("csharp", "C#", "csharp", ["cs", "c#"]),
  lang("css", "CSS"),
  lang("dart", "Dart"),
  lang("diff", "Diff", "diff", ["patch"]),
  lang("dockerfile", "Dockerfile", "dockerfile", ["docker"]),
  lang("elixir", "Elixir", "elixir", ["ex", "exs"]),
  lang("go", "Go", "go", ["golang"]),
  lang("graphql", "GraphQL", "graphql", ["gql"]),
  lang("haskell", "Haskell", "haskell", ["hs"]),
  lang("html", "HTML", "xml", ["htm", "xhtml"]),
  lang("java", "Java"),
  lang("javascript", "JavaScript", "javascript", ["js", "jsx", "mjs", "cjs"]),
  lang("json", "JSON", "json", ["jsonc", "json5"]),
  lang("kotlin", "Kotlin", "kotlin", ["kt", "kts"]),
  lang("latex", "LaTeX", "latex", ["tex"]),
  lang("lua", "Lua"),
  lang("makefile", "Makefile", "makefile", ["make", "mk"]),
  lang("markdown", "Markdown", "markdown", ["md"]),
  lang("objectivec", "Objective-C", "objectivec", ["objc", "obj-c"]),
  lang("php", "PHP"),
  lang("powershell", "PowerShell", "powershell", ["ps1", "pwsh", "ps"]),
  lang("python", "Python", "python", ["py", "python3"]),
  lang("r", "R"),
  lang("ruby", "Ruby", "ruby", ["rb"]),
  lang("rust", "Rust", "rust", ["rs"]),
  lang("scala", "Scala"),
  lang("scss", "SCSS", "scss", ["sass"]),
  lang("sql", "SQL", "sql", ["postgresql", "postgres", "mysql", "sqlite"]),
  lang("swift", "Swift"),
  lang("toml", "TOML / INI", "ini", ["ini", "cfg", "conf"]),
  lang("typescript", "TypeScript", "typescript", ["ts", "tsx", "mts", "cts"]),
  lang("xml", "XML", "xml", ["svg", "plist"]),
  lang("yaml", "YAML", "yaml", ["yml"]),
];

const BY_NAME = new Map<string, Language>();
for (const language of LANGUAGES) {
  BY_NAME.set(language.id, language);
  for (const alias of language.aliases) BY_NAME.set(alias, language);
}

/** The language a fence name means ("ts" → TypeScript), or undefined for names we don't know. */
export function findLanguage(name: string): Language | undefined {
  return BY_NAME.get(name.trim().toLowerCase());
}
