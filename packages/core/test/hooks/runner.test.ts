import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHooks, type HookPayload } from "../../src/hooks/runner.js";
import type { HooksConfig } from "../../src/hooks/config.js";

const basePayload = (overrides: Partial<HookPayload> = {}): HookPayload => ({
  hook_event_name: "PreToolUse",
  session_id: "test-session",
  cwd: "/tmp",
  ...overrides,
});

describe("hooks/runner (real subprocess execution, real shell commands)", () => {
  it("returns no decision when a hook exits 0 with no output", async () => {
    const config: HooksConfig = { PreToolUse: [{ hooks: [{ type: "command", command: "cat > /dev/null; exit 0" }] }] };
    const outcome = await runHooks(config, "PreToolUse", basePayload({ tool_name: "bash" }), "/tmp");
    expect(outcome.decision).toBeUndefined();
  });

  it("blocks via exit code 2, using stderr as the reason", async () => {
    const config: HooksConfig = {
      PreToolUse: [{ hooks: [{ type: "command", command: "cat > /dev/null; echo 'nope, not allowed' >&2; exit 2" }] }],
    };
    const outcome = await runHooks(config, "PreToolUse", basePayload({ tool_name: "bash" }), "/tmp");
    expect(outcome.decision).toBe("block");
    expect(outcome.reason).toBe("nope, not allowed");
  });

  it("approves via structured JSON on stdout, bypassing exit-code interpretation", async () => {
    const config: HooksConfig = {
      PreToolUse: [{ hooks: [{ type: "command", command: `cat > /dev/null; echo '{"decision":"approve","reason":"trusted"}'` }] }],
    };
    const outcome = await runHooks(config, "PreToolUse", basePayload({ tool_name: "bash" }), "/tmp");
    expect(outcome.decision).toBe("approve");
    expect(outcome.reason).toBe("trusted");
  });

  it("blocks via structured JSON on stdout even with exit code 0", async () => {
    const config: HooksConfig = {
      PreToolUse: [{ hooks: [{ type: "command", command: `cat > /dev/null; echo '{"decision":"block","reason":"policy violation"}'` }] }],
    };
    const outcome = await runHooks(config, "PreToolUse", basePayload({ tool_name: "bash" }), "/tmp");
    expect(outcome.decision).toBe("block");
    expect(outcome.reason).toBe("policy violation");
  });

  it("passes the real JSON payload to the hook on stdin", async () => {
    const config: HooksConfig = {
      PreToolUse: [{ hooks: [{ type: "command", command: "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).tool_name))\"" }] }],
    };
    const outcome = await runHooks(config, "PreToolUse", basePayload({ tool_name: "very_specific_tool_name" }), "/tmp");
    expect(outcome.output).toBe("very_specific_tool_name");
  });

  it("only runs a hook whose matcher regex matches the tool name", async () => {
    const config: HooksConfig = {
      PreToolUse: [{ matcher: "^bash$", hooks: [{ type: "command", command: "cat > /dev/null; echo matched" }] }],
    };
    const matched = await runHooks(config, "PreToolUse", basePayload({ tool_name: "bash" }), "/tmp");
    expect(matched.output).toBe("matched");

    const unmatched = await runHooks(config, "PreToolUse", basePayload({ tool_name: "write_file" }), "/tmp");
    expect(unmatched.output).toBeUndefined();
  });

  it("runs hooks in order and stops at the first one that decides", async () => {
    const config: HooksConfig = {
      PreToolUse: [
        { hooks: [{ type: "command", command: "cat > /dev/null; echo first-ran; exit 0" }] },
        { hooks: [{ type: "command", command: `cat > /dev/null; echo '{"decision":"block","reason":"stop here"}'` }] },
        { hooks: [{ type: "command", command: "touch /tmp/finanfa-hook-runner-test-should-not-run-$$" }] },
      ],
    };
    const outcome = await runHooks(config, "PreToolUse", basePayload({ tool_name: "bash" }), "/tmp");
    expect(outcome.decision).toBe("block");
    expect(outcome.reason).toBe("stop here");
  });

  it("kills a hook that exceeds its own timeout and treats it as no opinion", async () => {
    const config: HooksConfig = {
      PreToolUse: [{ hooks: [{ type: "command", command: "cat > /dev/null; sleep 5", timeout: 0.2 }] }],
    };
    const start = Date.now();
    const outcome = await runHooks(config, "PreToolUse", basePayload({ tool_name: "bash" }), "/tmp");
    expect(Date.now() - start).toBeLessThan(2000);
    expect(outcome.decision).toBeUndefined();
  });

  it("runs the hook with the given cwd", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-hook-cwd-"));
    const config: HooksConfig = { PreToolUse: [{ hooks: [{ type: "command", command: "cat > /dev/null; pwd" }] }] };
    const outcome = await runHooks(config, "PreToolUse", basePayload({ tool_name: "bash" }), dir);
    expect(outcome.output).toBe(dir);
  });

  it("returns no decision and no output when the event has no configured hooks", async () => {
    const outcome = await runHooks({}, "PreToolUse", basePayload({ tool_name: "bash" }), "/tmp");
    expect(outcome).toEqual({});
  });
});
