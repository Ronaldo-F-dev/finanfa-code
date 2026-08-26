import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { CommandInfo, StatusInfo, UIAdapter } from "./adapter.js";

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
  let atLineStart = true;
  let lastStatus: StatusInfo | undefined;

  return {
    writeAssistantDelta(text: string): void {
      stdout.write(text);
      atLineStart = text.endsWith("\n");
    },
    writeSystem(text: string): void {
      if (!atLineStart) stdout.write("\n");
      stdout.write(`\x1b[2m${text}\x1b[0m\n`);
      atLineStart = true;
    },
    writeError(text: string): void {
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
    async askUser(prompt: string): Promise<string> {
      if (!atLineStart) stdout.write("\n");
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
      }
    },
    close(): void {
      rl.close();
    },
  };
}
