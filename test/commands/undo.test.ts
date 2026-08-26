import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandRegistry } from "../../src/commands/registry.js";
import { registerBuiltinCommands } from "../../src/commands/builtin.js";
import { AgentSession } from "../../src/core/session.js";
import type { UIAdapter } from "../../src/ui/adapter.js";

function makeUi(): UIAdapter {
  return {
    writeAssistantDelta: vi.fn(),
    endAssistantMessage: vi.fn(),
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

describe("/undo command", () => {
  let dir: string;
  let commands: CommandRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-undo-cmd-"));
    commands = new CommandRegistry();
    registerBuiltinCommands(commands);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("restores a file's previous content", async () => {
    const filePath = path.join(dir, "a.txt");
    await writeFile(filePath, "original");
    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "s" });
    session.history.push({ path: filePath, before: "original" });
    await writeFile(filePath, "changed by the agent");

    const ui = makeUi();
    const handler = commands.get("undo")!;
    const outcome = await handler({ session, ui, tools: undefined as never, permissions: undefined as never, mcp: undefined as never, cwd: dir, args: "" });

    expect(outcome).toBe("continue");
    expect(await readFile(filePath, "utf-8")).toBe("original");
  });

  it("deletes a file that didn't exist before the recorded change", async () => {
    const filePath = path.join(dir, "created.txt");
    await writeFile(filePath, "new file content");
    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "s" });
    session.history.push({ path: filePath, before: undefined });

    const ui = makeUi();
    const handler = commands.get("undo")!;
    await handler({ session, ui, tools: undefined as never, permissions: undefined as never, mcp: undefined as never, cwd: dir, args: "" });

    await expect(readFile(filePath, "utf-8")).rejects.toThrow();
  });

  it("reports when there is nothing to undo", async () => {
    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "s" });
    const ui = makeUi();
    const handler = commands.get("undo")!;

    await handler({ session, ui, tools: undefined as never, permissions: undefined as never, mcp: undefined as never, cwd: dir, args: "" });

    expect(ui.writeSystem).toHaveBeenCalledWith("Nothing to undo.");
  });
});
