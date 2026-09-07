import { describe, expect, it } from "vitest";
import { countConfiguredHooks } from "../src/cli.js";
import type { HooksConfig } from "@finanfa/core/src/hooks/config.js";

describe("countConfiguredHooks (startup status line helper)", () => {
  it("returns 0 for an empty config", () => {
    expect(countConfiguredHooks({})).toBe(0);
  });

  it("counts every hook command across every matcher for one event", () => {
    const config: HooksConfig = {
      PreToolUse: [
        { hooks: [{ type: "command", command: "a" }, { type: "command", command: "b" }] },
        { matcher: "bash", hooks: [{ type: "command", command: "c" }] },
      ],
    };
    expect(countConfiguredHooks(config)).toBe(3);
  });

  it("sums across all three events", () => {
    const config: HooksConfig = {
      PreToolUse: [{ hooks: [{ type: "command", command: "a" }] }],
      PostToolUse: [{ hooks: [{ type: "command", command: "b" }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "c" }] }],
    };
    expect(countConfiguredHooks(config)).toBe(3);
  });
});
