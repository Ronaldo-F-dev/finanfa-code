import { describe, expect, it, beforeAll } from "vitest";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRead1PasswordSecretTool } from "../../src/tools/builtin/onepassword.js";

const FAKE_OP_SCRIPT = fileURLToPath(new URL("../fixtures/fake-op.mjs", import.meta.url));
const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("read_1password_secret tool (real subprocess, fake op binary stand-in)", () => {
  beforeAll(async () => {
    await chmod(FAKE_OP_SCRIPT, 0o755);
  });

  it("has 'dangerous' risk level — a secret read is never session-allowlistable", () => {
    expect(createRead1PasswordSecretTool({ binary: FAKE_OP_SCRIPT }).riskLevel).toBe("dangerous");
  });

  it("scopes the permission riskKey by the exact reference, not the whole tool", () => {
    const tool = createRead1PasswordSecretTool({ binary: FAKE_OP_SCRIPT });
    expect(tool.riskKey?.({ reference: "op://Personal/GitHub/token" })).toBe("read_1password_secret:op://Personal/GitHub/token");
  });

  it("reads a real secret value via `op read <reference>`", async () => {
    const tool = createRead1PasswordSecretTool({ binary: FAKE_OP_SCRIPT });
    const result = await tool.handler({ reference: "op://Personal/GitHub/token" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("secret-value-for-op://Personal/GitHub/token");
  });

  it("reports a real op-level error (unknown reference) as isError, with the real stderr content", async () => {
    const tool = createRead1PasswordSecretTool({ binary: FAKE_OP_SCRIPT });
    const result = await tool.handler({ reference: "op://Personal/Missing/field" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("isn't a secret reference");
  });
});
