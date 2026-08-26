export interface StatusInfo {
  tokens: number;
  costUsd: number;
  model: string;
}

export interface UIAdapter {
  writeAssistantDelta(text: string): void;
  writeSystem(text: string): void;
  writeError(text: string): void;
  setStatus(status: StatusInfo): void;
  getStatus(): StatusInfo | undefined;
  /** `kind: "confirm"` is used for permission prompts; `"input"` for normal chat input. */
  askUser(prompt: string, kind?: "input" | "confirm"): Promise<string>;
  close(): void;
}
