import { EventEmitter } from "node:events";
import type { CommandInfo, StatusInfo } from "@finanfa/core/src/ui/adapter.js";
import type { ToolRiskLevel } from "@finanfa/core/src/core/types.js";

export type LogItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "system"; text: string }
  | { kind: "error"; text: string }
  | { kind: "banner"; version: string }
  | { kind: "tool"; toolName: string; description: string; riskLevel: ToolRiskLevel };

export interface PendingPrompt {
  text: string;
  kind: "input" | "confirm";
}

export class UiStore extends EventEmitter {
  log: LogItem[] = [];
  streaming = "";
  status: StatusInfo | undefined;
  prompt: PendingPrompt | undefined;
  commands: CommandInfo[] = [];
  busy = false;
  busyLabel: string | undefined;
  // Set each time busy flips to true — lets the UI show elapsed time on the
  // spinner (e.g. "thinking... 47s") instead of a bare label that looks
  // identical whether it's been running for 2 seconds or 10 minutes. Real
  // reported confusion: a slow local model produced no visible output for
  // several minutes, indistinguishable from a hung process.
  busySince: number | undefined;

  pushLog(item: LogItem): void {
    this.log = [...this.log, item];
    this.emit("change");
  }

  appendDelta(text: string): void {
    this.streaming += text;
    this.emit("change");
  }

  commitStreaming(): void {
    if (this.streaming.length > 0) {
      this.pushLog({ kind: "assistant", text: this.streaming });
      this.streaming = "";
    }
  }

  setStatus(status: StatusInfo): void {
    this.status = status;
    this.emit("change");
  }

  setPrompt(prompt: PendingPrompt | undefined): void {
    this.prompt = prompt;
    this.emit("change");
  }

  setCommands(commands: CommandInfo[]): void {
    this.commands = commands;
    this.emit("change");
  }

  setBusy(busy: boolean, label?: string): void {
    this.busy = busy;
    this.busyLabel = label;
    this.busySince = busy ? Date.now() : undefined;
    this.emit("change");
  }
}
