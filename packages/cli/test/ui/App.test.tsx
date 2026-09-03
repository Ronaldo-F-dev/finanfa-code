import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../../src/ui/ink/App.js";
import { UiStore } from "../../src/ui/ink/store.js";

// Ink attaches its stdin "readable" listener (and processes input events)
// inside useEffect/microtask callbacks, so tests that drive stdin.write()
// must yield back to the event loop before reading the next frame.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Ink App", () => {
  it("renders logged messages", () => {
    const store = new UiStore();
    store.pushLog({ kind: "user", text: "hello" });
    store.pushLog({ kind: "assistant", text: "hi there" });

    const { lastFrame } = render(<App store={store} onSubmit={vi.fn()} />);

    expect(lastFrame()).toContain("hello");
    expect(lastFrame()).toContain("hi there");
  });

  it("shows the status bar once usage is recorded", () => {
    const store = new UiStore();
    store.setStatus({ tokens: 42, costUsd: 0.0123, model: "claude-sonnet-5" });

    const { lastFrame } = render(<App store={store} onSubmit={vi.fn()} />);

    expect(lastFrame()).toContain("tokens=42");
    expect(lastFrame()).toContain("claude-sonnet-5");
  });

  it("shows the permission prompt text when kind is confirm", () => {
    const store = new UiStore();
    store.setPrompt({ text: "run bash: rm -rf /tmp/x", kind: "confirm" });

    const { lastFrame } = render(<App store={store} onSubmit={vi.fn()} />);

    expect(lastFrame()).toContain("run bash: rm -rf /tmp/x");
  });

  it("shows matching command suggestions as the user types a slash command", async () => {
    const store = new UiStore();
    store.setCommands([
      { name: "cost", description: "Show usage" },
      { name: "clear", description: "Clear history" },
      { name: "exit", description: "Quit" },
    ]);

    const { lastFrame, stdin } = render(<App store={store} onSubmit={vi.fn()} />);
    await tick();
    stdin.write("/c");
    await tick();

    const frame = lastFrame();
    expect(frame).toContain("/cost");
    expect(frame).toContain("/clear");
    expect(frame).not.toContain("/exit — Quit");
  });

  it("does not show suggestions for plain (non-slash) input", async () => {
    const store = new UiStore();
    store.setCommands([{ name: "cost", description: "Show usage" }]);

    const { lastFrame, stdin } = render(<App store={store} onSubmit={vi.fn()} />);
    await tick();
    stdin.write("hello");
    await tick();

    expect(lastFrame()).not.toContain("Show usage");
  });

  it("completes the input to the selected suggestion on Tab", async () => {
    const store = new UiStore();
    store.setCommands([{ name: "cost", description: "Show usage" }]);

    const { lastFrame, stdin } = render(<App store={store} onSubmit={vi.fn()} />);
    await tick();
    stdin.write("/co");
    await tick();
    stdin.write("\t");
    await tick();

    expect(lastFrame()).toContain("/cost");
  });

  it("navigates suggestions with arrow keys", async () => {
    const store = new UiStore();
    store.setCommands([
      { name: "cost", description: "Show usage" },
      { name: "clear", description: "Clear history" },
    ]);

    const { lastFrame, stdin } = render(<App store={store} onSubmit={vi.fn()} />);
    await tick();
    stdin.write("/c");
    await tick();
    // cost is selected first (›); move down to clear, then Tab-complete it.
    stdin.write("[B");
    await tick();
    stdin.write("\t");
    await tick();

    expect(lastFrame()).toContain("/clear");
  });

  it("does not show suggestions during a permission (confirm) prompt", async () => {
    const store = new UiStore();
    store.setCommands([{ name: "cost", description: "Show usage" }]);
    store.setPrompt({ text: "", kind: "confirm" });

    const { lastFrame, stdin } = render(<App store={store} onSubmit={vi.fn()} />);
    await tick();
    stdin.write("/c");
    await tick();

    expect(lastFrame()).not.toContain("Show usage");
  });

  it("shows a busy indicator with its label when busy", () => {
    const store = new UiStore();
    store.setBusy(true, "thinking");

    const { lastFrame } = render(<App store={store} onSubmit={vi.fn()} />);

    expect(lastFrame()).toContain("thinking...");
  });

  it("hides the busy indicator once work finishes", () => {
    const store = new UiStore();
    store.setBusy(true, "running bash");
    store.setBusy(false);

    const { lastFrame } = render(<App store={store} onSubmit={vi.fn()} />);

    expect(lastFrame()).not.toContain("running bash");
  });

  it("renders a markdown table (from a committed assistant message) as an aligned table, not raw pipes", () => {
    const store = new UiStore();
    store.pushLog({
      kind: "assistant",
      text: "| Nom | Langage |\n|---|---|\n| finanfa-code | TypeScript |",
    });

    const { lastFrame } = render(<App store={store} onSubmit={vi.fn()} />);
    const frame = lastFrame();

    expect(frame).toContain("finanfa-code");
    expect(frame).toContain("TypeScript");
    expect(frame).toMatch(/[┌┬┐├┼┤└┴┘─│]/);
  });

  it("renders the live-streaming assistant text as markdown too (bold, not literal asterisks)", () => {
    const store = new UiStore();
    store.appendDelta("**hello**");

    const { lastFrame } = render(<App store={store} onSubmit={vi.fn()} />);

    expect(lastFrame()).not.toContain("**hello**");
    expect(lastFrame()).toContain("hello");
  });
});
