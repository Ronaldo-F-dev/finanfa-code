import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

let configuredWidth: number | undefined;

function ensureConfigured(): void {
  const width = process.stdout.columns || 80;
  if (configuredWidth === width) return;
  configuredWidth = width;
  // marked-terminal's TerminalRenderer type doesn't structurally match marked's
  // own MarkedExtension type (a known friction between the two packages' type
  // definitions, not a real incompatibility — marked-terminal's own docs use
  // this exact call). Safe to cast past it.
  marked.use(markedTerminal({ width, reflowText: true, tab: 2 }) as Parameters<typeof marked.use>[0]);
}

/**
 * Renders markdown (headings, bold/italic, tables, code blocks, lists, links)
 * to an ANSI-formatted string for terminal display. Re-configures marked's
 * renderer if the terminal width changed since the last call (tables/reflow
 * need it). Safe to call on partial/incomplete markdown — falls back to the
 * original text on parse failure.
 */
export function renderMarkdown(text: string): string {
  if (text.trim().length === 0) return text;
  ensureConfigured();
  try {
    const rendered = marked.parse(text, { async: false }) as string;
    return rendered.replace(/\n+$/, "");
  } catch {
    return text;
  }
}
