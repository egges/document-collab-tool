// Code blocks as in Notion: ``` starts one, the language is detected by
// itself (or picked), and the code is highlighted.
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { $prose } from "@milkdown/kit/utils";
import { autoLanguagePlugin } from "./auto.ts";
import { highlightPlugin } from "./highlight.ts";
import { autoPairs, codeFenceInputRule, codeKeymap } from "./keys.ts";
import { codeBlockView } from "./view.ts";

export const codeBlocks: MilkdownPlugin[] = [
  codeFenceInputRule,
  codeKeymap,
  autoPairs,
  codeBlockView,
  $prose(() => highlightPlugin()),
  $prose(() => autoLanguagePlugin()),
].flat();

export { detectLanguage } from "./detect.ts";
export { LANGUAGES, findLanguage, type Language } from "./languages.ts";
