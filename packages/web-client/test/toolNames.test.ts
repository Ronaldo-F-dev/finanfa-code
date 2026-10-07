import { describe, expect, it } from "vitest";
import { toolLabel } from "../src/i18n/toolNames";

describe("toolLabel", () => {
  it("turns an id into words in English", () => {
    expect(toolLabel("ask_user", "en")).toBe("Ask user");
    expect(toolLabel("git_push", "en")).toBe("Git push");
  });
  it("uses a hand-written French name when there is one, words otherwise", () => {
    expect(toolLabel("ask_user", "fr")).toBe("Poser une question");
    expect(toolLabel("serial_open", "fr")).toBe("Serial open");
  });
  it("shows an MCP tool as server: action", () => {
    expect(toolLabel("mcp__github__create_issue", "en")).toBe("github: Create issue");
  });
});
