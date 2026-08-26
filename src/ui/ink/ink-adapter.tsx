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
  );

  return {
    writeAssistantDelta(text: string): void {
      store.appendDelta(text);
    },
    writeSystem(text: string): void {
      store.commitStreaming();
      store.pushLog({ kind: "system", text });
    },
    writeError(text: string): void {
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
    askUser(prompt: string, kind: "input" | "confirm" = "input"): Promise<string> {
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
