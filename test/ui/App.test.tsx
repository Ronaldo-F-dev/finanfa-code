import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../../src/ui/ink/App.js";
import { UiStore } from "../../src/ui/ink/store.js";

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
});
