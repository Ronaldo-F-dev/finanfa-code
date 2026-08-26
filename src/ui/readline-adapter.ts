import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { StatusInfo, UIAdapter } from "./adapter.js";

export function createReadlineAdapter(): UIAdapter {
  const rl = readline.createInterface({ input: stdin, output: stdout });
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
