import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerShutdownHandlers } from "../src/cli.js";
import { AgentSession } from "@finanfa/core/src/core/session.js";
import { McpClientManager } from "@finanfa/core/src/mcp/client-manager.js";
import { BrowserManager } from "@finanfa/core/src/browser/manager.js";
import type { UIAdapter } from "@finanfa/core/src/ui/adapter.js";

function makeUi(): UIAdapter {
  return {
    writeAssistantDelta: vi.fn(),
    endAssistantMessage: vi.fn(),
    writeBanner: vi.fn(),
    writeSystem: vi.fn(),
    writeError: vi.fn(),
    setStatus: vi.fn(),
    getStatus: vi.fn().mockReturnValue(undefined),
    setCommands: vi.fn(),
    setBusy: vi.fn(),
    askUser: vi.fn().mockResolvedValue(""),
    close: vi.fn(),
  };
}

/** Everything each case below needs — factored out since the four tests only differ in isBusy()/which signal/how many times it fires, not in what they build or assert against. */
function makeFixture(dir: string) {
  const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "s" });
  const mcp = new McpClientManager();
  const browser = new BrowserManager();
  const ui = makeUi();
  return {
    session,
    mcp,
    browser,
    ui,
    disconnectAllSpy: vi.spyOn(mcp, "disconnectAll").mockResolvedValue(undefined),
    persistSpy: vi.spyOn(session, "persist").mockResolvedValue(undefined),
  };
}

/** registerShutdownHandlers's own listener is async (it awaits session.persist()/mcp.disconnectAll() before process.exit) — one setImmediate per await level lets each of those actually resolve before assertions run. */
function flushMicrotasks(times = 1): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => new Promise((resolve) => setImmediate(resolve)));
  return p;
}

// registerShutdownHandlers registers real process.on("SIGINT"/"SIGTERM")
// listeners — removed after every test so one test's handler can't fire on
// a later test's signal, and process.exit is stubbed throughout this file
// since the real shutdown() path calls it, which would otherwise kill the
// whole vitest worker.
describe("registerShutdownHandlers: a Ctrl+C (SIGINT) while a turn is busy stops only that turn, not the whole process", () => {
  let dir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-soft-interrupt-"));
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(async () => {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    exitSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  it("aborts the in-flight turn's controller(s) and keeps the process alive, instead of the full shutdown sequence", async () => {
    const { session, mcp, browser, ui, disconnectAllSpy } = makeFixture(dir);
    const controller = new AbortController();
    session.activeAbortControllers.add(controller);

    registerShutdownHandlers(() => session, mcp, browser, ui, () => true);
    process.emit("SIGINT");
    await flushMicrotasks();

    expect(controller.signal.aborted).toBe(true);
    expect(ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("stopping the current turn"));
    expect(disconnectAllSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("falls through to the full shutdown (persist, disconnect MCP, exit) when nothing is in flight", async () => {
    const { session, mcp, browser, ui, disconnectAllSpy, persistSpy } = makeFixture(dir);

    registerShutdownHandlers(() => session, mcp, browser, ui, () => false);
    process.emit("SIGINT");
    await flushMicrotasks(2);

    expect(persistSpy).toHaveBeenCalled();
    expect(disconnectAllSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("a second Ctrl+C within 1s forces the full shutdown even while busy — an escape hatch if the soft interrupt doesn't unstick things", async () => {
    const { session, mcp, browser, ui, disconnectAllSpy } = makeFixture(dir);

    registerShutdownHandlers(() => session, mcp, browser, ui, () => true);
    process.emit("SIGINT");
    await flushMicrotasks();
    process.emit("SIGINT");
    await flushMicrotasks(2);

    expect(disconnectAllSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("SIGTERM always does the full shutdown, even while busy — not a user-initiated 'stop this turn' signal", async () => {
    const { session, mcp, browser, ui, disconnectAllSpy } = makeFixture(dir);

    registerShutdownHandlers(() => session, mcp, browser, ui, () => true);
    process.emit("SIGTERM");
    await flushMicrotasks(2);

    expect(disconnectAllSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
