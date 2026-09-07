export interface StatusInfo {
  tokens: number;
  costUsd: number;
  model: string;
  /** Whether /plan is currently on — shown persistently in the status bar, not just as a one-time /plan message, since it changes what tools will actually do for the rest of the session. */
  planMode?: boolean;
}

export interface CommandInfo {
  name: string;
  description: string;
}

export interface UIAdapter {
  writeAssistantDelta(text: string): void;
  /** Signals that the assistant's text for the current turn is fully streamed — flushes/renders it (e.g. as formatted markdown). */
  endAssistantMessage(): void;
  /** One-time colored startup banner (name/tagline/version) — separate from writeSystem so each adapter can render it richly. */
  writeBanner(version: string): void;
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
  /** A tool produced a file the human should be able to play/view inline (e.g. text_to_speech's MP3) — optional, since a terminal can't render it; the CLI adapters just skip this and rely on the tool's own printed output. */
  writeMedia?(media: { kind: "audio" | "image"; path: string; mimeType: string }): void;
  close(): void;
}
