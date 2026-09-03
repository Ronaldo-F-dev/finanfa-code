import { describe, expect, it } from "vitest";

// chalk (used by marked-terminal under the hood) auto-disables color when
// stdout isn't a real TTY, which is always true under the test runner —
// force it on so the ANSI-output assertions below are meaningful. Must be
// set before renderMarkdown (and its chalk/marked-terminal imports) load;
// scoped to this file only since vitest isolates modules per test file.
process.env.FORCE_COLOR = "1";
const { renderMarkdown } = await import("../../src/ui/markdown.js");

describe("renderMarkdown", () => {
  it("renders a markdown table as an aligned box-drawn table, not raw pipes", () => {
    const table = [
      "| Nom | Langage | Privé |",
      "|---|---|---|",
      "| finanfa-code | TypeScript | ✅ |",
      "| mydevops | Python | ✅ |",
    ].join("\n");

    const rendered = renderMarkdown(table);

    // Should no longer be the raw "| a | b |" markdown source...
    expect(rendered).not.toBe(table);
    // ...but a real table with box-drawing borders, and the cell content preserved.
    expect(rendered).toMatch(/[┌┬┐├┼┤└┴┘─│]/);
    expect(rendered).toContain("finanfa-code");
    expect(rendered).toContain("TypeScript");
    expect(rendered).toContain("mydevops");
  });

  it("renders bold/italic as ANSI escape codes instead of literal asterisks", () => {
    const rendered = renderMarkdown("**bold** and *italic*");
    // eslint-disable-next-line no-control-regex
    expect(rendered).toMatch(/\x1b\[/); // contains at least one ANSI escape sequence
    expect(rendered).not.toContain("**bold**");
  });

  it("renders headings distinctly from plain text", () => {
    const heading = renderMarkdown("# Title");
    const plain = renderMarkdown("Title");
    expect(heading).not.toBe(plain);
    expect(heading).toContain("Title");
  });

  it("passes plain text through without corrupting it", () => {
    expect(renderMarkdown("just a plain sentence.")).toContain("just a plain sentence.");
  });

  it("does not throw on incomplete/partial markdown (mid-stream table)", () => {
    expect(() => renderMarkdown("| Nom | Lang")).not.toThrow();
    expect(() => renderMarkdown("**unterminated bold")).not.toThrow();
    expect(() => renderMarkdown("```ts\nconst x = 1;")).not.toThrow();
  });

  it("returns the input unchanged for empty/whitespace-only text", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("   ")).toBe("   ");
  });
});
