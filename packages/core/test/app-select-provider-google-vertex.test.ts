import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { GoogleAuth } from "google-auth-library";
import { selectProvider } from "../src/app.js";
import { GoogleVertexProvider } from "../src/providers/google-vertex-provider.js";

// See app-select-provider-azure.test.ts's own comment on why these env vars
// must be cleared before AND after every test here.
const ENV_KEYS = ["FINANFA_PROVIDER", "FINANFA_MODEL", "FINANFA_VERTEX_REGION", "FINANFA_VERTEX_PROJECT_ID"] as const;

describe("selectProvider: provider 'google-vertex'", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    // AnthropicVertex's constructor eagerly calls this._auth.getClient() —
    // real Application Default Credentials resolution, which rejects (as
    // an *unhandled* rejection, since the SDK never awaits it until an
    // actual request) on any machine/CI runner with no GCP credentials
    // configured. Stubbed so construction alone never touches the network.
    vi.spyOn(GoogleAuth.prototype, "getClient").mockResolvedValue({} as never);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    vi.restoreAllMocks();
  });

  it("selects a real GoogleVertexProvider instance, using the Vertex model id as defaultModel", () => {
    const { provider, defaultModel, kind } = selectProvider({
      provider: "google-vertex",
      model: "claude-sonnet-5@20250929",
      vertexRegion: "us-central1",
      vertexProjectId: "my-gcp-project",
    });
    expect(provider).toBeInstanceOf(GoogleVertexProvider);
    expect(kind).toBe("google-vertex");
    expect(defaultModel).toBe("claude-sonnet-5@20250929");
  });

  it("throws a clear error when the model is missing", () => {
    expect(() =>
      selectProvider({ provider: "google-vertex", vertexRegion: "us-central1", vertexProjectId: "my-gcp-project" }),
    ).toThrow(/requires a model, region, and GCP project id/);
  });

  it("throws a clear error when the region is missing", () => {
    expect(() =>
      selectProvider({ provider: "google-vertex", model: "claude-sonnet-5@20250929", vertexProjectId: "my-gcp-project" }),
    ).toThrow(/requires a model, region, and GCP project id/);
  });

  it("throws a clear error when the project id is missing", () => {
    expect(() =>
      selectProvider({ provider: "google-vertex", model: "claude-sonnet-5@20250929", vertexRegion: "us-central1" }),
    ).toThrow(/requires a model, region, and GCP project id/);
  });
});
