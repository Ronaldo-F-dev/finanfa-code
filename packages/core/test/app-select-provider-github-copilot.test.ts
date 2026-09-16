import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { selectProvider } from "../src/app.js";
import { GithubCopilotProvider } from "../src/providers/github-copilot-provider.js";

// See app-select-provider-azure.test.ts's own comment on why these env vars
// must be cleared before AND after every test here.
const ENV_KEYS = ["FINANFA_PROVIDER", "FINANFA_BASE_URL", "FINANFA_MODEL", "FINANFA_GITHUB_COPILOT_TOKEN"] as const;

describe("selectProvider: provider 'github-copilot'", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("selects a real GithubCopilotProvider instance, defaulting the model when unset", () => {
    const { provider, defaultModel, kind } = selectProvider({ provider: "github-copilot", githubCopilotToken: "gho_realtoken" });
    expect(provider).toBeInstanceOf(GithubCopilotProvider);
    expect(kind).toBe("github-copilot");
    expect(defaultModel).toBe("gpt-4o");
  });

  it("uses config.model when set, instead of the default", () => {
    const { defaultModel } = selectProvider({ provider: "github-copilot", githubCopilotToken: "gho_realtoken", model: "claude-sonnet-5" });
    expect(defaultModel).toBe("claude-sonnet-5");
  });

  it("throws a clear error when the GitHub token is missing", () => {
    expect(() => selectProvider({ provider: "github-copilot" })).toThrow(/requires a GitHub token/);
  });
});
