import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentSession } from "../../src/core/session.js";
import { rewindSession } from "../../src/core/rewind.js";
import { compactSession, runTurn } from "../../src/core/loop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import type { LlmProvider, StreamTurnResult } from "../../src/core/types.js";
import type { UIAdapter } from "../../src/ui/adapter.js";

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
    askUser: vi.fn().mockResolvedValue("y"),
    close: vi.fn(),
  };
}

const reply = (content: string): LlmProvider =>
  ({
    async streamTurn(): Promise<StreamTurnResult> {
      return { assistantMessage: { role: "assistant", content }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
    },
  }) as LlmProvider;

let dir: string;
const originalHome = process.env.HOME;
beforeEach(async () => {
  process.env.HOME = await mkdtemp(path.join(tmpdir(), "finanfa-rewind-home-"));
  dir = await mkdtemp(path.join(tmpdir(), "finanfa-rewind-"));
});
afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(dir, { recursive: true, force: true });
});

/** A session with two answered user turns, the second of which edited a file and created another. */
async function sessionWithTwoTurns() {
  const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "s" });
  const edited = path.join(dir, "edited.txt");
  const created = path.join(dir, "created.txt");
  await writeFile(edited, "original\n");

  session.messages.push({ role: "user", content: "first request" }, { role: "assistant", content: "first answer" });
  session.checkpoints.push({ messageIndex: 1, historySize: 0, preview: "first request" });

  session.messages.push({ role: "user", content: "second request" });
  session.checkpoints.push({ messageIndex: 3, historySize: 0, preview: "second request" });
  await writeFile(edited, "changed\n");
  session.history.push({ path: edited, before: "original\n" });
  await writeFile(created, "new\n");
  session.history.push({ path: created, before: undefined });
  session.messages.push({ role: "assistant", content: "second answer" });
  return { session, edited, created };
}

describe("rewindSession", () => {
  it("restores edited files, deletes files the rewound turns created, and cuts the conversation back", async () => {
    const { session, edited, created } = await sessionWithTwoTurns();
    const result = await rewindSession(session, 2);

    expect(result).toEqual({ preview: "second request", revertedFiles: 2, remainingMessages: 2 });
    expect(await readFile(edited, "utf-8")).toBe("original\n");
    await expect(stat(created)).rejects.toThrow();
    expect(session.messages.map((m) => (m as { content: string }).content)).toEqual(["first request", "first answer"]);
    expect(session.checkpoints.map((c) => c.preview)).toEqual(["first request"]);
  });

  it("can rewind to the very first message, emptying the conversation", async () => {
    const { session } = await sessionWithTwoTurns();
    const result = await rewindSession(session, 1);
    expect(result).toMatchObject({ preview: "first request", remainingMessages: 0 });
    expect(session.messages).toEqual([]);
    expect(session.checkpoints).toEqual([]);
  });

  it("returns undefined, and touches nothing, for a number that isn't a checkpoint", async () => {
    const { session, edited } = await sessionWithTwoTurns();
    for (const bad of [0, 3, -1, 1.5, Number.NaN]) expect(await rewindSession(session, bad)).toBeUndefined();
    expect(session.messages).toHaveLength(4);
    expect(await readFile(edited, "utf-8")).toBe("changed\n");
  });

  it("drops errors recorded after messages that no longer exist, so they can't resurface later", async () => {
    const { session } = await sessionWithTwoTurns();
    session.errorLog.push({ text: "kept", afterMessageIndex: 2 }, { text: "stale", afterMessageIndex: 4 });
    await rewindSession(session, 2);
    expect(session.errorLog.map((e) => e.text)).toEqual(["kept"]);
  });

  it("a second rewind after the first still lines up (numbers stay stable for the checkpoints that remain)", async () => {
    const { session } = await sessionWithTwoTurns();
    await rewindSession(session, 2);
    expect(await rewindSession(session, 2)).toBeUndefined(); // checkpoint 2 is gone
    expect(await rewindSession(session, 1)).toMatchObject({ preview: "first request" });
  });
});

describe("checkpoints recorded by runTurn", () => {
  it("carry the clientId a UI gave the turn", async () => {
    const ui = makeUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "s" });
    await runTurn(session, reply("ok"), ui, new ToolRegistry(), permissions, "hello", undefined, undefined, { clientId: "msg-1" });
    await runTurn(session, reply("ok"), ui, new ToolRegistry(), permissions, "again");
    expect(session.checkpoints).toMatchObject([{ preview: "hello", clientId: "msg-1" }, { preview: "again" }]);
    expect(session.checkpoints[1]).not.toHaveProperty("clientId");
  });

  it("are cleared by compaction, whose new message array they would no longer index", async () => {
    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "s" });
    session.messages.push({ role: "user", content: "q1" }, { role: "assistant", content: "a1" }, { role: "user", content: "q2" }, { role: "assistant", content: "a2" });
    session.checkpoints.push({ messageIndex: 1, historySize: 0, preview: "q1" }, { messageIndex: 3, historySize: 0, preview: "q2" });
    expect(await compactSession(session, reply("a summary of the conversation"))).toBeDefined();
    expect(session.messages).toHaveLength(2);
    expect(session.checkpoints).toEqual([]);
    // ...so a stale number now says "no such checkpoint" instead of reverting files and leaving the conversation alone.
    expect(await rewindSession(session, 2)).toBeUndefined();
  });
});
