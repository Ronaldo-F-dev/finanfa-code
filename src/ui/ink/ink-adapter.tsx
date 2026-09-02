import React from "react";
import { render } from "ink";
import type { CommandInfo, StatusInfo, UIAdapter } from "../adapter.js";
import { UiStore } from "./store.js";
import { App } from "./App.js";

export function createInkAdapter(): UIAdapter {
  const store = new UiStore();
  let resolveInput: ((value: string) => void) | undefined;

  const { unmount } = render(
    <App
      store={store}
      onSubmit={(value) => {
        if (!resolveInput) return;
        const kind = store.prompt?.kind ?? "input";
        store.pushLog({ kind: kind === "input" ? "user" : "system", text: value });
        const resolve = resolveInput;
        resolveInput = undefined;
        store.setPrompt(undefined);
        resolve(value);
      }}
    />,
    // Ink's default Ctrl+C handling just unmounts the app without running our
    // shutdown logic (session persistence, closing MCP connections). We
    // handle Ctrl+C ourselves (see App.tsx) and raise a real SIGINT instead,
    // so both UI modes go through the one shutdown path in cli.ts.
    { exitOnCtrlC: false },
  );

  return {
    writeAssistantDelta(text: string): void {
      if (store.busy) store.setBusy(false);
      store.appendDelta(text);
    },
    endAssistantMessage(): void {
      store.commitStreaming();
    },
    writeBanner(version: string): void {
      store.pushLog({ kind: "banner", version });
    },
    writeSystem(text: string): void {
      store.setBusy(false);
      store.commitStreaming();
      store.pushLog({ kind: "system", text });
    },
    writeError(text: string): void {
      store.setBusy(false);
      store.commitStreaming();
      store.pushLog({ kind: "error", text });
    },
    setStatus(status: StatusInfo): void {
      store.setStatus(status);
    },
    getStatus(): StatusInfo | undefined {
      return store.status;
    },
    setCommands(commands: CommandInfo[]): void {
      store.setCommands(commands);
    },
    setBusy(busy: boolean, label?: string): void {
      store.setBusy(busy, label);
    },
    askUser(prompt: string, kind: "input" | "confirm" = "input"): Promise<string> {
      store.setBusy(false);
      store.commitStreaming();
      return new Promise<string>((resolve) => {
        resolveInput = resolve;
        store.setPrompt({ text: prompt, kind });
      });
    },
    close(): void {
      unmount();
    },
  };
}
