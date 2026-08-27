import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { killProcessGroup } from "../../src/util/process.js";

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => child.on("exit", () => resolve()));
}

describe("killProcessGroup", () => {
  it("kills a detached process group, including a backgrounded grandchild", async () => {
    // The shell backgrounds a long-running sleep and exits almost
    // immediately — without group-kill, that orphaned sleep would keep
    // running (and, in the real bash tool, keep an inherited stdio pipe open).
    const child = spawn("sh", ["-c", "sleep 30 & echo $!"], { detached: true });
    let backgroundPid = "";
    child.stdout?.on("data", (d) => (backgroundPid += d));
    await waitForExit(child);

    const pid = Number(backgroundPid.trim());
    expect(Number.isNaN(pid)).toBe(false);
    expect(() => process.kill(pid, 0)).not.toThrow(); // still alive

    killProcessGroup(child);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(() => process.kill(pid, 0)).toThrow(); // gone
  });

  it("does not throw when the process already exited", async () => {
    const child = spawn("true", [], { detached: true });
    await waitForExit(child);
    expect(() => killProcessGroup(child)).not.toThrow();
  });

  it("does not throw when pid is missing (spawn failed)", () => {
    const fakeChild = { pid: undefined, kill: () => true } as unknown as ReturnType<typeof spawn>;
    expect(() => killProcessGroup(fakeChild)).not.toThrow();
  });
});
