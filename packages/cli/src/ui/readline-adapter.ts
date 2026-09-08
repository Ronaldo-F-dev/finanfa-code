import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { CommandInfo, StatusInfo, UIAdapter } from "@finanfa/core/src/ui/adapter.js";
import type { ToolRiskLevel } from "@finanfa/core/src/core/types.js";
import { renderMarkdown } from "./markdown.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

// Same risk-level -> icon/color mapping as the Ink UI's ToolCallLine.tsx —
// kept in sync by eye since these are two different rendering targets
// (raw ANSI here vs Ink <Text>), not worth sharing a single source over.
const RISK_ANSI: Record<ToolRiskLevel, { icon: string; color: string }> = {
  safe: { icon: "›", color: "\x1b[36m" }, // cyan
  ask: { icon: "◆", color: "\x1b[33m" }, // yellow
  dangerous: { icon: "▲", color: "\x1b[31m" }, // red
};

export function createReadlineAdapter(): UIAdapter {
  let commands: CommandInfo[] = [];

  // Tab-completion for slash commands (e.g. "/mc<Tab>" -> "/mcp").
  function completer(line: string): [string[], string] {
    if (!line.startsWith("/")) return [[], line];
    const names = commands.map((c) => `/${c.name}`);
    const hits = names.filter((name) => name.startsWith(line));
    return [hits.length > 0 ? hits : names, line];
  }

  const rl = readline.createInterface({ input: stdin, output: stdout, completer });
  // Node's readline keeps internal cursor-position bookkeeping for its TTY
  // prompt for as long as the interface is "resumed" (actively listening).
  // If we write raw output (spinner frames, streamed text, tool logs) while
  // it's resumed but no question() is pending, that bookkeeping goes stale
  // and the terminal only repaints correctly on the next keystroke — the
  // exact "looks frozen until I press a key" symptom. Keeping the interface
  // paused except while a question() is actually in flight avoids this.
  rl.pause();
  let atLineStart = true;
  let lastStatus: StatusInfo | undefined;
  let spinnerTimer: NodeJS.Timeout | undefined;
  let spinnerFrame = 0;
  // Assistant text streams into this buffer instead of the terminal directly:
  // markdown (tables especially) can't be rendered correctly until the whole
  // message is known, so we show the "thinking" spinner for the full
  // duration and print the rendered result once endAssistantMessage() fires.
  let assistantBuffer = "";

  // Clears the in-progress spinner line (if any) before any other output is written.
  function clearSpinner(): void {
    if (!spinnerTimer) return;
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
    stdout.write("\r\x1b[K");
    atLineStart = true;
  }

  function flushAssistantBuffer(): void {
    if (assistantBuffer.length === 0) return;
    clearSpinner();
    if (!atLineStart) stdout.write("\n");
    stdout.write(renderMarkdown(assistantBuffer));
    stdout.write("\n");
    atLineStart = true;
    assistantBuffer = "";
  }

  return {
    writeAssistantDelta(text: string): void {
      assistantBuffer += text;
    },
    endAssistantMessage(): void {
      flushAssistantBuffer();
    },
    writeBanner(version: string): void {
      flushAssistantBuffer();
      clearSpinner();
      if (!atLineStart) stdout.write("\n");
      const CYAN = "\x1b[36m";
      const RESET = "\x1b[0m";
      const title = `ƒ finanfa-code v${version}`;
      const tagline = "your own coding agent — code, design, docs, data";
      // Padding is computed from the plain text first — ANSI escape codes
      // are invisible but still count toward string length, so wrapping a
      // string in color codes before measuring it would silently misalign
      // the box's right border.
      const width = Math.max(title.length, tagline.length) + 2;
      const pad = (text: string) => " ".repeat(width - text.length - 1);
      const row = (styled: string, plain: string) => `${CYAN}│ ${RESET}${styled}${pad(plain)}${CYAN}│${RESET}`;
      stdout.write(
        [
          `${CYAN}╭${"─".repeat(width)}╮${RESET}`,
          row(`\x1b[1m${title}${RESET}`, title),
          row(`\x1b[2m\x1b[3m${tagline}${RESET}`, tagline),
          `${CYAN}╰${"─".repeat(width)}╯${RESET}`,
          "",
        ].join("\n"),
      );
      atLineStart = true;
    },
    writeSystem(text: string): void {
      flushAssistantBuffer();
      clearSpinner();
      if (!atLineStart) stdout.write("\n");
      stdout.write(`\x1b[2m${text}\x1b[0m\n`);
      atLineStart = true;
    },
    writeError(text: string): void {
      flushAssistantBuffer();
      clearSpinner();
      if (!atLineStart) stdout.write("\n");
      stdout.write(`\x1b[31m${text}\x1b[0m\n`);
      atLineStart = true;
    },
    writeToolCall({ toolName, description, riskLevel }): void {
      flushAssistantBuffer();
      clearSpinner();
      if (!atLineStart) stdout.write("\n");
      const { icon, color } = RISK_ANSI[riskLevel];
      const descriptionPart = description ? `\x1b[2m  ${description}\x1b[0m` : "";
      stdout.write(`${color}\x1b[1m${icon} ${toolName}\x1b[0m${descriptionPart}\n`);
      atLineStart = true;
    },
    setStatus(status: StatusInfo): void {
      lastStatus = status;
    },
    getStatus(): StatusInfo | undefined {
      return lastStatus;
    },
    setCommands(next: CommandInfo[]): void {
      commands = next;
    },
    setBusy(busy: boolean, label?: string): void {
      clearSpinner();
      if (!busy) return;
      if (!atLineStart) stdout.write("\n");
      atLineStart = false;
      const draw = (): void => {
        stdout.write(`\r\x1b[1;36m${SPINNER_FRAMES[spinnerFrame++ % SPINNER_FRAMES.length]} ${label ?? "working"}...\x1b[0m`);
      };
      draw(); // show a frame immediately instead of waiting for the first interval tick
      spinnerTimer = setInterval(draw, SPINNER_INTERVAL_MS);
    },
    async askUser(prompt: string): Promise<string> {
      flushAssistantBuffer();
      clearSpinner();
      if (!atLineStart) stdout.write("\n");
      rl.resume();
      try {
        const answer = await rl.question(prompt);
        atLineStart = true;
        return answer;
      } catch {
        // stdin closed (EOF / Ctrl+D, or piped input exhausted while a
        // response was streaming) — treat it as a request to exit cleanly
        // rather than crashing with an unhandled rejection.
        atLineStart = true;
        return "/exit";
      } finally {
        rl.pause();
      }
    },
    close(): void {
      flushAssistantBuffer();
      clearSpinner();
      rl.close();
    },
  };
}
