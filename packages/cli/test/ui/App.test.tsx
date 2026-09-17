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

  it("shows a [PLAN MODE] tag in the status bar when planMode is on", () => {
    const store = new UiStore();
    store.setStatus({ tokens: 10, costUsd: 0.001, model: "claude-sonnet-5", planMode: true });

    const { lastFrame } = render(<App store={store} onSubmit={vi.fn()} />);

    expect(lastFrame()).toContain("PLAN MODE");
  });

  it("does not show the [PLAN MODE] tag when planMode is off", () => {
    const store = new UiStore();
    store.setStatus({ tokens: 10, costUsd: 0.001, model: "claude-sonnet-5", planMode: false });

    const { lastFrame } = render(<App store={store} onSubmit={vi.fn()} />);

    expect(lastFrame()).not.toContain("PLAN MODE");
  });

  it("renders a tool call line with its risk-level icon and description", () => {
    const store = new UiStore();
    store.pushLog({ kind: "tool", toolName: "bash", description: "rm -rf /tmp/x", riskLevel: "dangerous" });

    const { lastFrame } = render(<App store={store} onSubmit={vi.fn()} />);
    const frame = lastFrame();

    expect(frame).toContain("bash");
    expect(frame).toContain("rm -rf /tmp/x");
    expect(frame).toContain("▲"); // dangerous risk icon
  });

  it("uses a distinct icon for a safe tool call vs a dangerous one", () => {
    const store = new UiStore();
    store.pushLog({ kind: "tool", toolName: "read_file", description: "a.txt", riskLevel: "safe" });

    const { lastFrame } = render(<App store={store} onSubmit={vi.fn()} />);

    expect(lastFrame()).toContain("›"); // safe risk icon
  });

  it("shows the permission prompt text when kind is confirm", () => {
    const store = new UiStore();
    store.setPrompt({ text: "run bash: rm -rf /tmp/x", kind: "confirm" });

    const { lastFrame } = render(<App store={store} onSubmit={vi.fn()} />);

    expect(lastFrame()).toContain("run bash: rm -rf /tmp/x");
  });

  it("renders the confirm prompt inside a bordered dialog, not plain inline text", () => {
    const store = new UiStore();
    store.setPrompt({ text: "run bash: rm -rf /tmp/x", kind: "confirm" });

    const { lastFrame } = render(<App store={store} onSubmit={vi.fn()} />);
    const frame = lastFrame();

    expect(frame).toContain("⚠ Confirm");
    expect(frame).toMatch(/[╭╮╯╰─│]/); // a real border, not just dim text
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
    // Real bug in an earlier version of this exact test: it wrote the
    // literal characters "[B" (missing the actual ESC byte a down-arrow
    // keypress sends) — not recognized as a key at all, just typed into
    // the input as text — and still passed, because both "cost" and
    // "clear" are always listed in the dropdown regardless of which is
    // highlighted, so the assertion below was true either way. Asserting
    // the input value itself (Tab only completes to the HIGHLIGHTED one)
    // is what actually proves the arrow key moved the selection.
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

    const frame = lastFrame();
    expect(frame).toContain("> /clear");
    expect(frame).not.toContain("> /cost");
  });

  it("submits the highlighted suggestion on Enter, not the raw typed text — real reported bug (typing '/', arrowing to a command, and pressing Enter used to submit the literal '/')", async () => {
    const store = new UiStore();
    store.setCommands([
      { name: "cost", description: "Show usage" },
      { name: "clear", description: "Clear history" },
    ]);
    const onSubmit = vi.fn();

    const { stdin } = render(<App store={store} onSubmit={onSubmit} />);
    await tick();
    stdin.write("/");
    await tick();
    stdin.write("\x1B[B"); // down arrow — highlight the second suggestion ("clear")
    await tick();
    stdin.write("\r"); // Enter
    await tick();

    expect(onSubmit).toHaveBeenCalledWith("/clear");
  });

  it("Enter submits the raw text as usual when no suggestion is showing", async () => {
    const store = new UiStore();
    const onSubmit = vi.fn();

    const { stdin } = render(<App store={store} onSubmit={onSubmit} />);
    await tick();
    stdin.write("hello there");
    await tick();
    stdin.write("\r");
    await tick();

    expect(onSubmit).toHaveBeenCalledWith("hello there");
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

  it(
    "shows elapsed time on the busy indicator — real reported confusion: a slow local model produced " +
      "no visible output for minutes, indistinguishable from a hung process",
    () => {
      const store = new UiStore();
      store.setBusy(true, "thinking");
      // setBusy stamps busySince from the real clock — backdate it directly
      // rather than sleeping the test for real seconds.
      store.busySince = Date.now() - 65_000;

      const { lastFrame } = render(<App store={store} onSubmit={vi.fn()} />);
      const frame = lastFrame();

      expect(frame).toContain("thinking...");
      expect(frame).toMatch(/thinking\.\.\. 6[0-9]s/);
    },
  );

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
