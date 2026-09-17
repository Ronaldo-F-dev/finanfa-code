import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isCommandAvailable } from "../../src/util/command-availability.js";
import {
  createTmuxListSessionsTool,
  createTmuxNewSessionTool,
  createTmuxSendKeysTool,
  createTmuxCapturePaneTool,
  createTmuxKillSessionTool,
} from "../../src/tools/builtin/tmux.js";

// Real tmux binary, real sessions — this project's established
// convention (bash.ts/background-process.ts's own tests) is to exercise
// the actual external tool, not a mock. Skips cleanly when tmux isn't
// installed (same pattern as other conditionally-registered CLI-wrapping
// tools), rather than failing CI on a machine without it.
const hasTmux = isCommandAvailable("tmux");

describe.skipIf(!hasTmux)("tmux tools (real tmux binary, real sessions)", () => {
  let dir: string;
  let sessionName: string;
  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  afterEach(async () => {
    if (sessionName) {
      await createTmuxKillSessionTool().handler({ name: sessionName }, ctx()).catch(() => {});
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("creates a real session, sends keys, captures the real output, then kills it", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-tmux-"));
    sessionName = `finanfa-test-${randomUUID().slice(0, 8)}`;

    const created = await createTmuxNewSessionTool().handler({ name: sessionName }, ctx());
    expect(created.isError).toBe(false);
    expect(created.content).toContain(sessionName);

    const listed = await createTmuxListSessionsTool().handler({}, ctx());
    expect(listed.isError).toBe(false);
    expect(listed.content).toContain(sessionName);

    const sent = await createTmuxSendKeysTool().handler({ target: sessionName, keys: "echo hello-from-tmux" }, ctx());
    expect(sent.isError).toBe(false);

    // Give the shell inside the pane a moment to actually run the command.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const captured = await createTmuxCapturePaneTool().handler({ target: sessionName }, ctx());
    expect(captured.isError).toBe(false);
    expect(captured.content).toContain("hello-from-tmux");

    const killed = await createTmuxKillSessionTool().handler({ name: sessionName }, ctx());
    expect(killed.isError).toBe(false);

    const listedAfter = await createTmuxListSessionsTool().handler({}, ctx());
    expect(listedAfter.content).not.toContain(sessionName);
  });

  it("reports no sessions cleanly instead of erroring when none exist", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-tmux-"));
    sessionName = ""; // nothing to clean up
    // Killing the tmux server entirely would affect other tests running in
    // parallel — this test only asserts the "no sessions" message shape
    // when it happens to be empty, without forcing that state.
    const listed = await createTmuxListSessionsTool().handler({}, ctx());
    expect(listed.isError).toBe(false);
  });

  it("has the right risk levels — read-only ops safe, mutating ops ask/dangerous", () => {
    expect(createTmuxListSessionsTool().riskLevel).toBe("safe");
    expect(createTmuxCapturePaneTool().riskLevel).toBe("safe");
    expect(createTmuxNewSessionTool().riskLevel).toBe("ask");
    expect(createTmuxSendKeysTool().riskLevel).toBe("dangerous");
    expect(createTmuxKillSessionTool().riskLevel).toBe("dangerous");
  });
});
