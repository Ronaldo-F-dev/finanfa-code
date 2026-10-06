// Finanfa never shows the long dash. Same rule as packages/core/src/util/typography.ts (the browser bundle does not
// import core): code, fenced or inline, is left as written; everywhere else the dash becomes a comma.

const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g;

export function stripEmDashes(text: string): string {
  if (!text.includes("—")) return text;
  return text
    .split(CODE)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/\s+—\s+/g, ", ").replace(/—/g, "-")))
    .join("");
}
