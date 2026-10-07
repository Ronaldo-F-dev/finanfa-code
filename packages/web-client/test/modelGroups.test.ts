import { describe, expect, it } from "vitest";
import { groupModels, type PickerModel } from "../src/modelGroups";

const models: PickerModel[] = [
  { id: "claude-sonnet-5", family: "anthropic", configured: false },
  { id: "deepseek-v4-pro", family: "openai-compatible", configured: true, provider: "DeepSeek", baseUrl: "https://api.deepseek.com" },
  { id: "grok-4", family: "openai-compatible", configured: false, provider: "Grok (xAI)" },
  { id: "Ollama: llama3", family: "openai-compatible", configured: true, localModelId: "llama3", baseUrl: "http://localhost:11434/v1" },
  { id: "Ternary-Bonsai-4B", family: "openai-compatible", configured: true, local: true, running: false },
  { id: "my-model", family: "openai-compatible", configured: true },
];

describe("groupModels", () => {
  it("orders Claude, the cloud providers, this machine, then the rest", () => {
    expect(groupModels(models).map((g) => g.key)).toEqual(["claude", "cloud:DeepSeek", "cloud:Grok (xAI)", "local", "configured"]);
  });
  it("puts detected and config-defined local models together", () => {
    expect(groupModels(models).find((g) => g.key === "local")!.items.map((m) => m.id)).toEqual(["Ollama: llama3", "Ternary-Bonsai-4B"]);
  });
  it("filters by name or provider and drops empty groups", () => {
    expect(groupModels(models, "grok").map((g) => g.key)).toEqual(["cloud:Grok (xAI)"]);
    expect(groupModels(models, "deepseek").flatMap((g) => g.items.map((m) => m.id))).toEqual(["deepseek-v4-pro"]);
    expect(groupModels(models, "zzz")).toEqual([]);
  });
});
