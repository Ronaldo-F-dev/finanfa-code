export interface UIAdapter {
  writeAssistantDelta(text: string): void;
  writeSystem(text: string): void;
  writeError(text: string): void;
  setStatus(status: { tokens: number; costUsd: number; model: string }): void;
  askUser(prompt: string): Promise<string>;
  close(): void;
}
