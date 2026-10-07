import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import nginx from "highlight.js/lib/languages/nginx";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// Only the languages people actually ask an assistant for are bundled, to keep the app small. A fence with another
// language (or none) is shown as plain, escaped text rather than guessed at: a wrong guess colours code misleadingly.
const LANGUAGES = { bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, makefile, markdown, nginx, php, python, ruby, rust, sql, swift, typescript, xml, yaml };
for (const [name, definition] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, definition);

const ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  docker: "dockerfile",
  containerfile: "dockerfile",
  yml: "yaml",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  html: "xml",
  svg: "xml",
  toml: "ini",
  conf: "nginx",
  rs: "rust",
  cs: "csharp",
  kt: "kotlin",
  md: "markdown",
  rb: "ruby",
  make: "makefile",
  "c++": "cpp",
  golang: "go",
  patch: "diff",
};

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The language name highlight.js knows for a fence's label ("yml" -> "yaml"), or undefined when it is not bundled. */
export function resolveLanguage(label: string | undefined): string | undefined {
  const key = (label ?? "").trim().toLowerCase().split(/\s+/)[0] ?? "";
  const name = ALIASES[key] ?? key;
  return hljs.getLanguage(name) ? name : undefined;
}

/** HTML for the inside of a <code> element: coloured when the language is known, otherwise escaped plain text. */
export function highlightCode(code: string, label: string | undefined): { html: string; language: string | undefined } {
  const language = resolveLanguage(label);
  if (!language) return { html: escapeHtml(code), language: undefined };
  try {
    return { html: hljs.highlight(code, { language, ignoreIllegals: true }).value, language };
  } catch {
    return { html: escapeHtml(code), language: undefined };
  }
}
