import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { UIAdapter } from "./adapter.js";

export function createReadlineAdapter(): UIAdapter & {
  rl: readline.Interface;
  getStatus(): { tokens: number; costUsd: number; model: string } | undefined;
} {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  let atLineStart = true;
  let lastStatus: { tokens: number; costUsd: number; model: string } | undefined;

  return {
    rl,
    getStatus: () => lastStatus,
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
    setStatus(status): void {
      lastStatus = status;
    },
    async askUser(prompt: string): Promise<string> {
      if (!atLineStart) stdout.write("\n");
      const answer = await rl.question(prompt);
      atLineStart = true;
      return answer;
    },
    close(): void {
      rl.close();
    },
  };
}
