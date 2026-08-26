import { EventEmitter } from "node:events";
import type { CommandInfo, StatusInfo } from "../adapter.js";

export type LogItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "system"; text: string }
  | { kind: "error"; text: string };

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
    this.emit("change");
  }
}
