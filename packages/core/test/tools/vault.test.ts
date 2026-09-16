import { describe, expect, it, beforeAll } from "vitest";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createReadVaultSecretTool } from "../../src/tools/builtin/vault.js";

const FAKE_VAULT_SCRIPT = fileURLToPath(new URL("../fixtures/fake-vault.mjs", import.meta.url));
const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("read_vault_secret tool (real subprocess, fake vault binary stand-in)", () => {
  beforeAll(async () => {
    await chmod(FAKE_VAULT_SCRIPT, 0o755);
  });

  it("has 'dangerous' risk level — a secret read is never session-allowlistable", () => {
    expect(createReadVaultSecretTool({ binary: FAKE_VAULT_SCRIPT }).riskLevel).toBe("dangerous");
  });

  it("scopes the permission riskKey by path and field, not the whole tool", () => {
    const tool = createReadVaultSecretTool({ binary: FAKE_VAULT_SCRIPT });
    expect(tool.riskKey?.({ path: "secret/myapp/db", field: "password" })).toBe("read_vault_secret:secret/myapp/db:password");
  });

  it("reads a real secret field via `vault kv get -field=<field> <path>`", async () => {
    const tool = createReadVaultSecretTool({ binary: FAKE_VAULT_SCRIPT });
    const result = await tool.handler({ path: "secret/myapp/db", field: "password" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("vault-value-for-secret/myapp/db-password");
  });

  it("reports a real vault-level error (missing secret) as isError, with the real stderr content", async () => {
    const tool = createReadVaultSecretTool({ binary: FAKE_VAULT_SCRIPT });
    const result = await tool.handler({ path: "secret/missing", field: "password" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No value found");
  });
});
