import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDebugNodeTracebackTool } from "../../src/tools/builtin/debug-node.js";

describe("debug_node_traceback (real node subprocess)", () => {
  const ctx = (cwd: string) => ({ cwd, sessionId: "s", signal: new AbortController().signal });

  it("runs a script that completes normally and reports success with its real stdout", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-debug-node-"));
    try {
      await writeFile(path.join(dir, "ok.mjs"), "console.log('all good');\n");
      const tool = createDebugNodeTracebackTool();
      const result = await tool.handler({ script: "ok.mjs" }, ctx(dir));
      expect(result.isError).toBe(false);
      expect(result.content).toContain("all good");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("captures the real error's additional properties on an uncaught exception, beyond message/stack", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-debug-node-"));
    try {
      await writeFile(
        path.join(dir, "crash.mjs"),
        [
          "const err = new Error('order failed');",
          "err.orderId = 42;",
          "err.retryable = false;",
          "throw err;",
          "",
        ].join("\n"),
      );
      const tool = createDebugNodeTracebackTool();
      const result = await tool.handler({ script: "crash.mjs" }, ctx(dir));
      expect(result.isError).toBe(true);
      expect(result.content).toContain("order failed");
      expect(result.content).toContain("Additional error properties");
      expect(result.content).toContain("orderId = 42");
      expect(result.content).toContain("retryable = false");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("captures a chained .cause on an uncaught exception", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-debug-node-"));
    try {
      await writeFile(
        path.join(dir, "crash-cause.mjs"),
        [
          "const root = new Error('connection refused');",
          "throw new Error('failed to save order', { cause: root });",
          "",
        ].join("\n"),
      );
      const tool = createDebugNodeTracebackTool();
      const result = await tool.handler({ script: "crash-cause.mjs" }, ctx(dir));
      expect(result.isError).toBe(true);
      expect(result.content).toContain("failed to save order");
      expect(result.content).toContain("Caused by");
      expect(result.content).toContain("connection refused");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes through real script arguments", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-debug-node-"));
    try {
      await writeFile(path.join(dir, "echo_args.mjs"), "console.log(process.argv.slice(2));\n");
      const tool = createDebugNodeTracebackTool();
      const result = await tool.handler({ script: "echo_args.mjs", args: ["hello", "world"] }, ctx(dir));
      expect(result.isError).toBe(false);
      expect(result.content).toContain("hello");
      expect(result.content).toContain("world");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("has 'ask' risk level", () => {
    expect(createDebugNodeTracebackTool().riskLevel).toBe("ask");
  });
});
