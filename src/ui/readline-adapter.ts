import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { CommandInfo, StatusInfo, UIAdapter } from "./adapter.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

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

  // Clears the in-progress spinner line (if any) before any other output is written.
  function clearSpinner(): void {
    if (!spinnerTimer) return;
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
    stdout.write("\r\x1b[K");
    atLineStart = true;
  }

  return {
    writeAssistantDelta(text: string): void {
      clearSpinner();
      stdout.write(text);
      atLineStart = text.endsWith("\n");
    },
    writeSystem(text: string): void {
      clearSpinner();
      if (!atLineStart) stdout.write("\n");
      stdout.write(`\x1b[2m${text}\x1b[0m\n`);
      atLineStart = true;
    },
    writeError(text: string): void {
      clearSpinner();
      if (!atLineStart) stdout.write("\n");
      stdout.write(`\x1b[31m${text}\x1b[0m\n`);
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
      spinnerTimer = setInterval(() => {
        stdout.write(`\r\x1b[2m${SPINNER_FRAMES[spinnerFrame++ % SPINNER_FRAMES.length]} ${label ?? "working"}...\x1b[0m`);
      }, SPINNER_INTERVAL_MS);
    },
    async askUser(prompt: string): Promise<string> {
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
      clearSpinner();
      rl.close();
    },
  };
}
