// The long dash ("—") is a tell-tale of machine-written prose. Finanfa never shows it: the agent is told not to write
// it (STYLE_PROMPT) and what still slips through is rewritten here before it is displayed. Code (fenced or inline)
// is left exactly as written, since a dash in code or a path is not ours to change.

const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g;

export function stripEmDashes(text: string): string {
  if (!text.includes("—")) return text;
  return text
    .split(CODE)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/\s+—\s+/g, ", ").replace(/—/g, "-")))
    .join("");
}

export const STYLE_PROMPT = " Never write the long dash character (—) in your replies; use a comma, a colon, a period or parentheses instead. ";
