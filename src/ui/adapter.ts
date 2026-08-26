export interface StatusInfo {
  tokens: number;
  costUsd: number;
  model: string;
}

export interface CommandInfo {
  name: string;
  description: string;
}

export interface UIAdapter {
  writeAssistantDelta(text: string): void;
  /** Signals that the assistant's text for the current turn is fully streamed — flushes/renders it (e.g. as formatted markdown). */
  endAssistantMessage(): void;
  writeSystem(text: string): void;
  writeError(text: string): void;
  setStatus(status: StatusInfo): void;
  getStatus(): StatusInfo | undefined;
  /** Registers the available slash commands, used to drive autocomplete/suggestions. */
  setCommands(commands: CommandInfo[]): void;
  /** Shows/hides a loading indicator (e.g. while waiting on the model or a slow tool), with an optional label. */
  setBusy(busy: boolean, label?: string): void;
  /** `kind: "confirm"` is used for permission prompts; `"input"` for normal chat input. */
  askUser(prompt: string, kind?: "input" | "confirm"): Promise<string>;
  close(): void;
}
